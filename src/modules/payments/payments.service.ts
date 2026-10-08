/**
 * Orchestration du paiement : création du séquestre (calcul de la
 * commission), initiation via la passerelle générique, et traitement
 * idempotent des webhooks. SòôRooms ne détient jamais les fonds
 * elle-même — EscrowVault reflète l'état côté agrégateur, il ne stocke
 * pas un solde réel (voir schema.prisma).
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';
import type { PaymentMethod } from '../../prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  PAYMENT_GATEWAY,
  type PaymentCustomer,
  type PaymentGateway,
} from './interfaces/payment-gateway.interface.js';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService<AppConfig, true>,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  async initiate(bookingId: string, userId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { room: true, traveler: true },
    });
    if (!booking) {
      throw new NotFoundException('Réservation introuvable.');
    }
    if (booking.travelerId !== userId) {
      throw new ForbiddenException('Seul le voyageur de cette réservation peut initier le paiement.');
    }
    if (booking.status !== 'PENDING_PAYMENT') {
      throw new ConflictException("Cette réservation n'est pas en attente de paiement.");
    }
    if (booking.totalPrice == null) {
      throw new ConflictException("Le prix de cette réservation n'a pas encore été validé par les deux parties.");
    }

    const totalPrice = Number(booking.totalPrice);
    const escrow = await this.getOrCreateEscrow(booking.id, totalPrice);

    const customer = this.buildCustomer(booking.traveler);
    const frontendUrl = this.configService.get('frontendUrl', { infer: true });

    const { paymentUrl, gatewayRef } = await this.gateway.initiatePayment({
      amount: totalPrice,
      currency: 'XAF',
      // Référence neuve à chaque tentative : l'agrégateur exige une référence
      // unique par paiement, et un voyageur dont le premier essai a échoué doit
      // pouvoir réessayer. L'id de la réservation en est extrait au retour du webhook.
      reference: `${booking.id}_${Date.now().toString(36)}`,
      description: `Réservation — ${booking.room.name}`,
      customer,
      callbackUrl: `${frontendUrl}/profil/reservations/${booking.id}`,
    });

    return { escrowId: escrow.id, paymentUrl, gatewayRef };
  }

  /**
   * @param rawBody Corps brut de la requête, PAS le JSON re-sérialisé —
   *   la vérification de signature HMAC exige les octets exacts envoyés
   *   par l'agrégateur. Voir main.ts (option `rawBody: true`) et
   *   payments.controller.ts (@Req() pour accéder à req.rawBody).
   */
  async handleWebhook(rawBody: Buffer, signatureHeader: string | undefined) {
    const isValid = this.gateway.verifyWebhookSignature(rawBody, signatureHeader);
    if (!isValid) {
      throw new UnauthorizedException('Signature de webhook invalide.');
    }

    const event = this.gateway.parseWebhookPayload(rawBody);
    // Événement sans rapport avec un paiement de réservation (reversement,
    // client créé…) : on l'acquitte pour que l'agrégateur ne le renvoie pas.
    if (!event) {
      return { ignored: true };
    }

    // Idempotence : paymentGatewayId est unique en base (voir
    // schema.prisma). Un même webhook livré deux fois par l'agrégateur —
    // cas fréquent — ne doit jamais créer deux transactions ni
    // déclencher deux fois le passage en CONFIRMED_ESCROW.
    const existing = await this.prisma.transaction.findUnique({
      where: { paymentGatewayId: event.gatewayRef },
    });
    // Déjà traité = déjà SUCCESS, ou simple répétition d'un statut non final.
    // Mais une transaction d'abord PENDING/FAILED puis SUCCESS (cas normal :
    // l'agrégateur envoie plusieurs événements pour un même paiement) doit
    // bien finir par confirmer la réservation — l'ancienne version ignorait
    // tout webhook dont la référence existait déjà, et un paiement réussi
    // pouvait ainsi rester sans effet.
    if (existing && (existing.transactionStatus === 'SUCCESS' || event.status !== 'SUCCESS')) {
      return { alreadyProcessed: true };
    }

    const escrow = await this.prisma.escrowVault.findUnique({
      where: { bookingId: event.bookingReference },
    });
    if (!escrow) {
      throw new NotFoundException('Aucun séquestre correspondant à cette référence de réservation.');
    }

    // Un webhook, même signé, ne suffit pas à débloquer une réservation : on
    // interroge directement l'agrégateur et c'est SA réponse qui fait foi
    // (statut, montant, devise). Si la vérification échoue ou n'est pas encore
    // concluante, on répond par une erreur : l'agrégateur renverra la notification.
    let amount = event.amount;
    if (event.status === 'SUCCESS') {
      const verified = await this.gateway.verifyPayment(event.gatewayRef);
      if (verified.status !== 'SUCCESS') {
        this.logger.warn(
          `Webhook ${event.gatewayRef} annonce un succès mais l'agrégateur répond « ${verified.status} » : réservation ${escrow.bookingId} non confirmée.`,
        );
        throw new ConflictException("Paiement non confirmé par l'agrégateur.");
      }
      if (verified.currency !== 'XAF') {
        this.logger.error(`Webhook ${event.gatewayRef} : devise ${verified.currency || 'absente'} au lieu de XAF.`);
        throw new BadRequestException('Devise du paiement inattendue.');
      }
      amount = verified.amount;
    }

    // Un paiement « réussi » d'un montant différent de celui attendu ne doit
    // jamais confirmer la réservation (paiement partiel, montant altéré).
    if (event.status === 'SUCCESS' && Math.round(amount) !== Math.round(Number(escrow.amountHeld))) {
      this.logger.error(
        `Webhook ${event.gatewayRef} : montant reçu ${amount} ≠ montant attendu ${String(escrow.amountHeld)} (réservation ${escrow.bookingId}). Vérification manuelle requise.`,
      );
      throw new BadRequestException('Montant du paiement différent du montant attendu.');
    }
    // Les événements d'échec ne portent pas toujours un montant exploitable.
    const recordedAmount = Number.isFinite(amount) && amount > 0 ? amount : Number(escrow.amountHeld);

    await this.applyPayment({
      escrow,
      existing,
      gatewayRef: event.gatewayRef,
      status: event.status,
      amount: recordedAmount,
      paymentMethod: event.paymentMethod,
      payload: JSON.parse(rawBody.toString('utf-8')),
    });

    return { processed: true };
  }

  /**
   * Vérification au RETOUR du voyageur, sans dépendre d'un webhook : à son retour de la page de
   * paiement, le frontend nous transmet la référence ; on relit le paiement chez l'agrégateur et on
   * confirme exactement comme le ferait le webhook (même écriture, même idempotence). C'est aussi
   * le filet de sécurité d'un webhook perdu ou arrivé pendant que le serveur dormait.
   *
   * Sécurité : la référence vient du client, donc elle n'est jamais crue sur parole. Seule compte la
   * réponse de l'agrégateur, qui doit désigner CETTE réservation (sinon on pourrait payer une petite
   * réservation et présenter son paiement pour en confirmer une plus chère), au bon montant, en XAF.
   */
  async verifyReturn(bookingId: string, userId: string, reference: string) {
    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking) {
      throw new NotFoundException('Réservation introuvable.');
    }
    if (booking.travelerId !== userId) {
      throw new ForbiddenException('Seul le voyageur de cette réservation peut vérifier son paiement.');
    }

    // Le webhook est parfois arrivé avant le retour du voyageur : rien à refaire.
    if (['CONFIRMED_ESCROW', 'COMPLETED', 'DISPUTED'].includes(booking.status)) {
      return { confirmed: true, paymentStatus: 'SUCCESS' as const, bookingStatus: booking.status };
    }
    if (booking.status !== 'PENDING_PAYMENT') {
      throw new ConflictException("Cette réservation n'est pas en attente de paiement.");
    }

    const verified = await this.gateway.verifyPayment(reference);

    if (verified.bookingReference !== booking.id) {
      this.logger.error(
        `Vérification au retour : le paiement ${verified.gatewayRef} se rattache à « ${verified.bookingReference ?? 'aucune réservation reconnaissable'} », pas à ${booking.id}.`,
      );
      throw new ForbiddenException('Ce paiement ne correspond pas à cette réservation.');
    }

    const escrow = await this.prisma.escrowVault.findUnique({ where: { bookingId: booking.id } });
    if (!escrow) {
      throw new NotFoundException('Aucun paiement lancé pour cette réservation.');
    }

    // Paiement encore en cours chez l'opérateur : on ne conclut pas, le frontend réessaiera.
    if (verified.status === 'PENDING') {
      return { confirmed: false, paymentStatus: 'PENDING' as const, bookingStatus: booking.status };
    }

    const existing = await this.prisma.transaction.findUnique({ where: { paymentGatewayId: verified.gatewayRef } });
    const payload = { source: 'return-verification', transaction: verified.raw };

    if (verified.status === 'FAILED') {
      // Ne jamais rétrograder un paiement déjà confirmé.
      if (existing?.transactionStatus !== 'SUCCESS') {
        await this.applyPayment({
          escrow,
          existing,
          gatewayRef: verified.gatewayRef,
          status: 'FAILED',
          amount: Number.isFinite(verified.amount) && verified.amount > 0 ? verified.amount : Number(escrow.amountHeld),
          paymentMethod: verified.paymentMethod,
          payload,
        });
      }
      return { confirmed: false, paymentStatus: 'FAILED' as const, bookingStatus: booking.status };
    }

    if (verified.currency !== 'XAF') {
      this.logger.error(`Vérification au retour ${verified.gatewayRef} : devise ${verified.currency || 'absente'} au lieu de XAF.`);
      throw new BadRequestException('Devise du paiement inattendue.');
    }
    if (Math.round(verified.amount) !== Math.round(Number(escrow.amountHeld))) {
      this.logger.error(
        `Vérification au retour ${verified.gatewayRef} : montant ${verified.amount} ≠ montant attendu ${String(escrow.amountHeld)} (réservation ${booking.id}). Vérification manuelle requise.`,
      );
      throw new BadRequestException('Montant du paiement différent du montant attendu.');
    }

    await this.applyPayment({
      escrow,
      existing,
      gatewayRef: verified.gatewayRef,
      status: 'SUCCESS',
      amount: verified.amount,
      paymentMethod: verified.paymentMethod,
      payload,
    });

    const after = await this.prisma.booking.findUnique({ where: { id: booking.id } });
    return { confirmed: true, paymentStatus: 'SUCCESS' as const, bookingStatus: after?.status ?? 'CONFIRMED_ESCROW' };
  }

  /**
   * Écriture commune au webhook et à la vérification au retour : enregistre (ou met à jour) la
   * transaction, et, pour un succès, fait avancer la réservation. Idempotente par construction :
   * `paymentGatewayId` est unique, et la réservation n'avance que depuis PENDING_PAYMENT.
   */
  private async applyPayment(params: {
    escrow: { id: string; bookingId: string };
    existing: { id: string } | null;
    gatewayRef: string;
    status: 'SUCCESS' | 'FAILED' | 'PENDING';
    amount: number;
    paymentMethod: PaymentMethod;
    payload: unknown;
  }) {
    const { escrow, existing, gatewayRef, status, amount, paymentMethod, payload } = params;

    await this.prisma.$transaction(async (tx) => {
      if (existing) {
        await tx.transaction.update({
          where: { id: existing.id },
          data: { transactionStatus: status, amount, rawWebhookPayload: payload as never },
        });
      } else {
        await tx.transaction.create({
          data: {
            escrowId: escrow.id,
            paymentGatewayId: gatewayRef,
            paymentMethod,
            amount,
            transactionStatus: status,
            rawWebhookPayload: payload as never,
          },
        });
      }

      if (status === 'SUCCESS') {
        // Les fonds sont désormais capturés et détenus par l'agrégateur
        // (EscrowVault reste HELD_IN_ESCROW). Seule la réservation avance, et
        // uniquement depuis PENDING_PAYMENT : un événement tardif ne doit pas
        // ressusciter une réservation annulée, en litige ou terminée.
        const moved = await tx.booking.updateMany({
          where: { id: escrow.bookingId, status: 'PENDING_PAYMENT' },
          data: { status: 'CONFIRMED_ESCROW' },
        });
        if (moved.count === 0) {
          this.logger.error(
            `Paiement SUCCESS reçu pour la réservation ${escrow.bookingId} qui n'est plus PENDING_PAYMENT : remboursement manuel à prévoir.`,
          );
        }
      }
    });
  }

  /**
   * Déclenche le reversement à l'hôte. Appelée par BookingsService une
   * fois les deux confirmations (voyageur + hôte) obtenues — jamais
   * directement par une route HTTP, pour qu'il soit impossible de
   * déclencher un reversement sans être passé par la double validation.
   * Idempotente : si déjà RELEASED_TO_HOST, ne fait rien.
   */
  async releaseEscrow(bookingId: string) {
    return this.prisma.$transaction(
      async (tx) => {
        // Verrou sur la ligne du séquestre : deux appels simultanés (les deux
        // parties confirment au même instant) s'exécutent l'un après l'autre,
        // le second voit RELEASED_TO_HOST et ne reverse pas une seconde fois.
        await tx.$queryRaw`SELECT id FROM "EscrowVault" WHERE "bookingId" = ${bookingId} FOR UPDATE`;

        const escrow = await tx.escrowVault.findUnique({ where: { bookingId } });
        if (!escrow) {
          throw new NotFoundException('Aucun séquestre pour cette réservation.');
        }
        if (escrow.status !== 'HELD_IN_ESCROW') {
          return escrow;
        }

        await this.gateway.releaseFunds({
          amount: Number(escrow.hostPayout),
          reference: bookingId,
        });

        return tx.escrowVault.update({
          where: { id: escrow.id },
          data: { status: 'RELEASED_TO_HOST' },
        });
      },
      { timeout: 30_000 },
    );
  }

  private buildCustomer(traveler: { fullName: string; phone: string; email: string | null }): PaymentCustomer {
    // Les comptes créés via Google reçoivent un numéro factice « google:<id> »
    // (voir AuthService.loginWithGoogle) : on ne le transmet jamais à l'agrégateur.
    const phone = /^\+?\d{8,15}$/.test(traveler.phone) ? traveler.phone : undefined;
    const email = traveler.email ?? undefined;
    if (!phone && !email) {
      throw new BadRequestException(
        'Ajoutez un numéro de téléphone ou une adresse e-mail à votre compte avant de payer.',
      );
    }
    return { name: traveler.fullName, phone, email };
  }

  private async getOrCreateEscrow(bookingId: string, totalPrice: number) {
    const existing = await this.prisma.escrowVault.findUnique({ where: { bookingId } });
    if (existing) {
      return existing;
    }

    const feePercent = this.configService.get('payment.platformFeePercent', { infer: true });
    const platformFee = Math.round((totalPrice * feePercent) / 100);
    const hostPayout = totalPrice - platformFee;

    return this.prisma.escrowVault.create({
      data: { bookingId, amountHeld: totalPrice, platformFee, hostPayout },
    });
  }
}

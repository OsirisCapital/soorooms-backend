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

    const payload = JSON.parse(rawBody.toString('utf-8'));

    await this.prisma.$transaction(async (tx) => {
      if (existing) {
        await tx.transaction.update({
          where: { id: existing.id },
          data: { transactionStatus: event.status, amount: recordedAmount, rawWebhookPayload: payload },
        });
      } else {
        await tx.transaction.create({
          data: {
            escrowId: escrow.id,
            paymentGatewayId: event.gatewayRef,
            paymentMethod: event.paymentMethod,
            amount: recordedAmount,
            transactionStatus: event.status,
            rawWebhookPayload: payload,
          },
        });
      }

      if (event.status === 'SUCCESS') {
        // Les fonds sont désormais capturés et détenus par l'agrégateur
        // (EscrowVault reste HELD_IN_ESCROW). Seule la réservation avance, et
        // uniquement depuis PENDING_PAYMENT : un webhook tardif ne doit pas
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

    return { processed: true };
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

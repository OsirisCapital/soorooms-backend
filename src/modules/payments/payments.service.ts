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
import { PAYMENT_GATEWAY, type PaymentGateway } from './interfaces/payment-gateway.interface.js';

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
      include: { room: true },
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

    const { paymentUrl, gatewayRef } = await this.gateway.initiatePayment({
      amount: totalPrice,
      currency: 'XAF',
      reference: booking.id,
      description: `Réservation — ${booking.room.name}`,
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

    // Un paiement « réussi » d'un montant différent de celui attendu ne doit
    // jamais confirmer la réservation (paiement partiel, montant altéré).
    if (event.status === 'SUCCESS' && Math.round(event.amount) !== Math.round(Number(escrow.amountHeld))) {
      this.logger.error(
        `Webhook ${event.gatewayRef} : montant reçu ${event.amount} ≠ montant attendu ${String(escrow.amountHeld)} (réservation ${escrow.bookingId}). Vérification manuelle requise.`,
      );
      throw new BadRequestException('Montant du paiement différent du montant attendu.');
    }

    const payload = JSON.parse(rawBody.toString('utf-8'));

    await this.prisma.$transaction(async (tx) => {
      if (existing) {
        await tx.transaction.update({
          where: { id: existing.id },
          data: { transactionStatus: event.status, rawWebhookPayload: payload },
        });
      } else {
        await tx.transaction.create({
          data: {
            escrowId: escrow.id,
            paymentGatewayId: event.gatewayRef,
            paymentMethod: event.paymentMethod,
            amount: event.amount,
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

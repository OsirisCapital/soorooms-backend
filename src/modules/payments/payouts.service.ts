/**
 * Versement aux hôtes, avec validation par la finance.
 *
 * Déroulement :
 *  1. Voyageur ET hôte ont confirmé → `queueForBooking` crée un versement « À verser » (TO_SEND).
 *     Aucun argent ne bouge.
 *  2. Un membre de la finance clique sur « Envoyer » → `send` réserve le versement (SENDING) dans une
 *     transaction qui écrit aussi le journal d'audit, PUIS appelle Notch Pay (Transfers). Deux clics
 *     simultanés ne peuvent donc jamais envoyer deux fois.
 *  3. Notch Pay conclut → webhook `transfer.*` ou bouton « Vérifier » : PAID (séquestre libéré, l'hôte
 *     est prévenu) ou FAILED (la finance peut réessayer avec une nouvelle référence).
 *
 * Règle d'or contre le double envoi : un échec n'est « sûr » (réessai permis) que si Notch Pay l'a
 * clairement refusé ou ne connaît pas notre référence. En cas de doute (réseau coupé après l'envoi),
 * le versement reste SENDING et seul « Vérifier » peut le trancher.
 */
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { PayoutStatus } from '../../prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import {
  PAYMENT_GATEWAY,
  type PaymentGateway,
  type PayoutChannel,
  type TransferState,
} from './interfaces/payment-gateway.interface.js';
import type { SetPayoutDetailsDto } from './dto/payout-details.dto.js';
import { normalizeCameroonMobile, PAYOUT_CHANNELS } from './payout-phone.js';

const RECENT_CHANGE_MS = 72 * 60 * 60 * 1000;
const SENDABLE: PayoutStatus[] = ['TO_SEND', 'FAILED'];
const IN_FLIGHT: PayoutStatus[] = ['SENDING', 'PROCESSING'];

type Details = { channel: string | null; phone: string | null; accountName: string | null; updatedAt: Date | null };

const isComplete = (d: Details | null): d is { channel: PayoutChannel; phone: string; accountName: string; updatedAt: Date | null } =>
  !!d && !!d.phone && !!d.accountName && (PAYOUT_CHANNELS as readonly string[]).includes(d.channel ?? '');

/** Un refus clair de Notch Pay (ou une config absente) : rien n'a été envoyé. Un 502 = on ne sait pas. */
export function isDefiniteRejection(error: unknown): boolean {
  return error instanceof HttpException && error.getStatus() !== 502;
}

@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  // ---------------------------------------------------------------------
  // Mise en file (appelée par PaymentsService.releaseEscrow)
  // ---------------------------------------------------------------------

  /** Idempotent : un séquestre n'a jamais qu'un seul versement. Renvoie le séquestre. */
  async queueForBooking(bookingId: string) {
    const result = await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "EscrowVault" WHERE "bookingId" = ${bookingId} FOR UPDATE`;
        const escrow = await tx.escrowVault.findUnique({ where: { bookingId }, include: { payout: true } });
        if (!escrow) throw new NotFoundException('Aucun séquestre pour cette réservation.');
        if (escrow.status !== 'HELD_IN_ESCROW' || escrow.payout) return { escrow, created: false as const };

        const booking = await tx.booking.findUnique({
          where: { id: bookingId },
          select: { room: { select: { property: { select: { title: true, collaborators: { where: { role: 'MANAGER' }, select: { userId: true }, take: 1 } } } } } },
        });
        const hostUserId = booking?.room.property.collaborators[0]?.userId ?? null;
        const profile = hostUserId
          ? await tx.hostProfile.findUnique({ where: { userId: hostUserId }, select: { payoutChannel: true, payoutPhone: true, payoutAccountName: true, payoutUpdatedAt: true } })
          : null;
        await tx.payout.create({ data: { escrowId: escrow.id, hostUserId, amount: escrow.hostPayout } });
        return {
          escrow,
          created: true as const,
          hostUserId,
          propertyTitle: booking?.room.property.title ?? '',
          needsDetails: !isComplete(profile && { channel: profile.payoutChannel, phone: profile.payoutPhone, accountName: profile.payoutAccountName, updatedAt: profile.payoutUpdatedAt }),
        };
      },
      { timeout: 15_000 },
    );

    if (result.created && this.notifications) {
      const amount = Number(result.escrow.hostPayout);
      if (result.hostUserId) {
        await this.notifications.notify(result.hostUserId, 'PAYOUT_QUEUED', { bookingId, amount, propertyTitle: result.propertyTitle, needsDetails: result.needsDetails });
      }
      await this.notifications.notifyStaff('payouts.manage', 'PAYOUT_TO_SEND_STAFF', { amount, propertyTitle: result.propertyTitle });
    }
    const { escrow } = result;
    return escrow;
  }

  // ---------------------------------------------------------------------
  // Côté finance
  // ---------------------------------------------------------------------

  /** `open` : à verser, en cours, en échec. `done` : déjà versés (100 derniers). */
  async list(view: 'open' | 'done' = 'open') {
    const rows = await this.prisma.payout.findMany({
      where: view === 'done' ? { status: 'PAID' } : { status: { not: 'PAID' } },
      orderBy: view === 'done' ? { paidAt: 'desc' } : { createdAt: 'asc' },
      take: 100,
      include: { escrow: { select: { bookingId: true, booking: { select: { checkInDate: true, checkOutDate: true, room: { select: { name: true, property: { select: { title: true, city: true } } } } } } } } },
    });
    const hostIds = [...new Set(rows.map((r) => r.hostUserId).filter((id): id is string => !!id))];
    const hosts = await this.prisma.user.findMany({
      where: { id: { in: hostIds } },
      select: { id: true, fullName: true, phone: true, hostProfile: { select: { payoutChannel: true, payoutPhone: true, payoutAccountName: true, payoutUpdatedAt: true } } },
    });
    const byId = new Map(hosts.map((h) => [h.id, h]));
    const now = Date.now();

    return rows.map((row) => {
      const host = row.hostUserId ? byId.get(row.hostUserId) : undefined;
      const hp = host?.hostProfile;
      const details: Details | null = hp ? { channel: hp.payoutChannel, phone: hp.payoutPhone, accountName: hp.payoutAccountName, updatedAt: hp.payoutUpdatedAt } : null;
      const complete = isComplete(details);
      const booking = row.escrow.booking;
      return {
        id: row.id,
        status: row.status,
        amount: Number(row.amount),
        attempts: row.attempts,
        failureReason: row.failureReason,
        createdAt: row.createdAt,
        sentAt: row.sentAt,
        paidAt: row.paidAt,
        bookingId: row.escrow.bookingId,
        propertyTitle: booking.room.property.title,
        city: booking.room.property.city,
        checkInDate: booking.checkInDate,
        checkOutDate: booking.checkOutDate,
        host: host ? { id: host.id, fullName: host.fullName, phone: host.phone } : null,
        details: details && complete ? { channel: details.channel, phone: details.phone, accountName: details.accountName, updatedAt: details.updatedAt } : null,
        // Un numéro changé il y a moins de 72 h est un signal d'alerte (compte piraté ?) : on le montre.
        detailsRecentlyChanged: complete && details.updatedAt ? now - details.updatedAt.getTime() < RECENT_CHANGE_MS : false,
        beneficiary: row.beneficiaryPhone ? { channel: row.beneficiaryChannel, phone: row.beneficiaryPhone, accountName: row.beneficiaryName } : null,
        canSend: SENDABLE.includes(row.status) && complete,
        canCheck: IN_FLIGHT.includes(row.status) && !!row.reference,
        // Virement fait à la main par la finance (hors Notch Pay) : permis tant que rien n'est en vol.
        canMarkPaid: SENDABLE.includes(row.status),
      };
    });
  }

  /** Clic sur « Envoyer ». Ne lève jamais d'erreur après la réservation : l'issue est dans le versement renvoyé. */
  async send(payoutId: string, actorId: string) {
    const payout = await this.prisma.payout.findUnique({
      where: { id: payoutId },
      include: { escrow: { select: { bookingId: true, booking: { select: { room: { select: { property: { select: { title: true } } } } } } } } },
    });
    if (!payout) throw new NotFoundException('Versement introuvable.');
    if (!SENDABLE.includes(payout.status)) {
      throw new ConflictException(payout.status === 'PAID' ? 'Ce versement a déjà été effectué.' : 'Ce versement est déjà en cours : utilisez « Vérifier ».');
    }

    const profile = payout.hostUserId
      ? await this.prisma.hostProfile.findUnique({ where: { userId: payout.hostUserId }, select: { payoutChannel: true, payoutPhone: true, payoutAccountName: true, payoutUpdatedAt: true } })
      : null;
    const details = profile && { channel: profile.payoutChannel, phone: profile.payoutPhone, accountName: profile.payoutAccountName, updatedAt: profile.payoutUpdatedAt };
    if (!isComplete(details)) {
      throw new BadRequestException("L'hôte n'a pas encore renseigné son numéro Mobile Money : on ne peut pas lui verser.");
    }

    const attempt = payout.attempts + 1;
    const reference = `po_${payout.id}_${attempt}`;
    const amount = Number(payout.amount);

    // Réservation atomique + audit : un seul appel peut passer de TO_SEND/FAILED à SENDING.
    const claimed = await this.prisma.$transaction(async (tx) => {
      const res = await tx.payout.updateMany({
        where: { id: payout.id, status: { in: SENDABLE }, attempts: payout.attempts },
        data: {
          status: 'SENDING',
          attempts: attempt,
          reference,
          gatewayRef: null,
          failureReason: null,
          beneficiaryChannel: details.channel,
          beneficiaryPhone: details.phone,
          beneficiaryName: details.accountName,
          sentById: actorId,
          sentAt: new Date(),
        },
      });
      if (res.count === 0) return false;
      await tx.auditLog.create({
        data: { actorId, action: 'payout.send', targetType: 'Payout', targetId: payout.id, meta: { bookingId: payout.escrow.bookingId, amount, attempt, reference } },
      });
      return true;
    });
    if (!claimed) throw new ConflictException('Ce versement vient d’être pris en charge par quelqu’un d’autre.');

    try {
      const state = await this.gateway.sendTransfer({
        amount,
        currency: 'XAF',
        reference,
        description: `Versement SòôRooms — ${payout.escrow.booking.room.property.title}`.slice(0, 120),
        beneficiary: { name: details.accountName, phone: details.phone, channel: details.channel },
      });
      await this.applyState(payout.id, state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Versement ${payout.id} (tentative ${attempt}) : ${message}`);
      if (isDefiniteRejection(error)) {
        await this.markFailed(payout.id, message);
      } else {
        // On ne sait pas si Notch Pay a reçu l'ordre : surtout ne pas permettre un nouvel envoi.
        await this.prisma.payout.updateMany({
          where: { id: payout.id, status: 'SENDING' },
          data: { failureReason: "Réponse de Notch Pay inconnue : cliquez sur « Vérifier » avant tout nouvel essai." },
        });
      }
    }
    return this.view(payout.id);
  }

  /**
   * La finance a versé l'argent elle-même (Orange Money / MTN, hors Notch Pay) et en saisit la preuve.
   * Même effet qu'un transfert réussi : PAID, séquestre libéré, hôte prévenu — mais avec un audit dédié
   * contenant la référence de l'opération. Refusé si un envoi Notch Pay est en vol (risque de double versement).
   */
  async markPaidManually(payoutId: string, actorId: string, proof: string) {
    const payout = await this.prisma.payout.findUnique({ where: { id: payoutId }, include: { escrow: { select: { bookingId: true } } } });
    if (!payout) throw new NotFoundException('Versement introuvable.');
    if (!SENDABLE.includes(payout.status)) {
      throw new ConflictException(payout.status === 'PAID' ? 'Ce versement a déjà été effectué.' : 'Un envoi Notch Pay est en cours : utilisez « Vérifier l’état » avant toute autre action.');
    }
    const reference = proof.trim().slice(0, 80);
    const amount = Number(payout.amount);
    const claimed = await this.prisma.$transaction(async (tx) => {
      const res = await tx.payout.updateMany({
        where: { id: payout.id, status: { in: SENDABLE }, attempts: payout.attempts },
        data: { status: 'SENDING', sentById: actorId, sentAt: new Date(), failureReason: null },
      });
      if (res.count === 0) return false;
      await tx.auditLog.create({
        data: { actorId, action: 'payout.manual_paid', targetType: 'Payout', targetId: payout.id, meta: { bookingId: payout.escrow.bookingId, amount, proof: reference } },
      });
      return true;
    });
    if (!claimed) throw new ConflictException('Ce versement vient d’être pris en charge par quelqu’un d’autre.');
    await this.applyState(payout.id, { status: 'COMPLETE', gatewayRef: `manuel:${reference}`, reference: payout.reference ?? `manuel_${payout.id}` });
    return this.view(payout.id);
  }

  /** Clic sur « Vérifier » : relit le transfert chez Notch Pay et met le versement à jour. */
  async check(payoutId: string, actorId: string) {
    const payout = await this.prisma.payout.findUnique({ where: { id: payoutId } });
    if (!payout) throw new NotFoundException('Versement introuvable.');
    if (!IN_FLIGHT.includes(payout.status) || !payout.reference) {
      throw new ConflictException("Ce versement n'a pas d'envoi à vérifier.");
    }
    const state = await this.gateway.getTransfer(payout.reference);
    if (!state) {
      if (payout.status === 'SENDING') {
        // Notch Pay n'a jamais reçu cet ordre : réessai sans risque.
        await this.markFailed(payout.id, "Notch Pay n'a pas reçu l'ordre d'envoi. Vous pouvez réessayer.");
      } else {
        throw new ConflictException('Notch Pay ne retrouve pas ce transfert : contactez Notch Pay avant de réessayer.');
      }
    } else {
      await this.applyState(payout.id, state);
    }
    await this.prisma.auditLog.create({ data: { actorId, action: 'payout.check', targetType: 'Payout', targetId: payout.id } });
    return this.view(payout.id);
  }

  /** Webhook `transfer.*` : on ne croit que la relecture directe chez Notch Pay. */
  async applyTransferEvent(reference: string) {
    const payout = await this.prisma.payout.findUnique({ where: { reference } });
    if (!payout) return { ignored: true };
    const state = await this.gateway.getTransfer(reference);
    if (!state || state.reference !== reference) {
      throw new ConflictException("Transfert non confirmé par l'agrégateur.");
    }
    await this.applyState(payout.id, state);
    return { processed: true };
  }

  // ---------------------------------------------------------------------
  // Côté hôte : où recevoir l'argent
  // ---------------------------------------------------------------------

  async getDetails(userId: string) {
    const p = await this.prisma.hostProfile.findUnique({
      where: { userId },
      select: { payoutChannel: true, payoutPhone: true, payoutAccountName: true, payoutUpdatedAt: true },
    });
    return { channel: p?.payoutChannel ?? null, phone: p?.payoutPhone ?? null, accountName: p?.payoutAccountName ?? null, updatedAt: p?.payoutUpdatedAt ?? null };
  }

  async setDetails(userId: string, dto: SetPayoutDetailsDto) {
    const phone = normalizeCameroonMobile(dto.phone);
    if (!phone) {
      throw new BadRequestException('Numéro invalide : indiquez un numéro mobile camerounais (9 chiffres, commençant par 6).');
    }
    const accountName = dto.accountName.replace(/\s+/g, ' ').trim();
    if (accountName.length < 2) throw new BadRequestException('Indiquez le nom du titulaire du compte.');
    const data = { payoutChannel: dto.channel, payoutPhone: phone, payoutAccountName: accountName, payoutUpdatedAt: new Date() };
    await this.prisma.hostProfile.upsert({ where: { userId }, update: data, create: { userId, ...data } });
    return this.getDetails(userId);
  }

  // ---------------------------------------------------------------------
  // Internes
  // ---------------------------------------------------------------------

  private view(payoutId: string) {
    return this.list('open').then(async (open) => open.find((p) => p.id === payoutId) ?? (await this.list('done')).find((p) => p.id === payoutId) ?? null);
  }

  private async markFailed(payoutId: string, reason: string) {
    const res = await this.prisma.payout.updateMany({
      where: { id: payoutId, status: { in: IN_FLIGHT } },
      data: { status: 'FAILED', failureReason: reason.slice(0, 300) },
    });
    if (res.count > 0) await this.notifyFailure(payoutId);
  }

  private async applyState(payoutId: string, state: TransferState) {
    if (state.status === 'COMPLETE') {
      const paid = await this.prisma.$transaction(async (tx) => {
        const res = await tx.payout.updateMany({
          where: { id: payoutId, status: { not: 'PAID' } },
          data: { status: 'PAID', paidAt: new Date(), gatewayRef: state.gatewayRef, failureReason: null },
        });
        if (res.count === 0) return null;
        const payout = await tx.payout.findUnique({ where: { id: payoutId }, select: { escrowId: true, amount: true, hostUserId: true, escrow: { select: { bookingId: true, booking: { select: { room: { select: { property: { select: { title: true } } } } } } } } } });
        if (!payout) return null;
        await tx.escrowVault.updateMany({ where: { id: payout.escrowId, status: 'HELD_IN_ESCROW' }, data: { status: 'RELEASED_TO_HOST' } });
        return payout;
      });
      // Une seule alerte : seulement si CET appel a fait passer le versement à PAID.
      if (paid?.hostUserId && this.notifications) {
        await this.notifications.notify(paid.hostUserId, 'PAYOUT_RELEASED', {
          bookingId: paid.escrow.bookingId,
          amount: Number(paid.amount),
          propertyTitle: paid.escrow.booking.room.property.title,
        });
      }
      return;
    }
    if (state.status === 'FAILED') {
      await this.markFailed(payoutId, state.failureReason ?? 'Transfert refusé par Notch Pay.');
      return;
    }
    await this.prisma.payout.updateMany({
      where: { id: payoutId, status: 'SENDING' },
      data: { status: 'PROCESSING', gatewayRef: state.gatewayRef, failureReason: null },
    });
  }

  private async notifyFailure(payoutId: string) {
    if (!this.notifications) return;
    try {
      const p = await this.prisma.payout.findUnique({
        where: { id: payoutId },
        select: { amount: true, escrow: { select: { booking: { select: { room: { select: { property: { select: { title: true } } } } } } } } },
      });
      if (!p) return;
      await this.notifications.notifyStaff('payouts.manage', 'PAYOUT_FAILED_STAFF', { amount: Number(p.amount), propertyTitle: p.escrow.booking.room.property.title });
    } catch (error) {
      this.logger.error(`Alerte d'échec de versement non envoyée : ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

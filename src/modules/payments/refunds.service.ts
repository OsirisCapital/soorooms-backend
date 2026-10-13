/**
 * Remboursement des voyageurs, avec validation par la finance. Même circuit que PayoutsService :
 *  1. Une annulation (ou un litige tranché) crée un remboursement « À rembourser » (TO_SEND) avec le
 *     numéro Mobile Money indiqué par le voyageur. Aucun argent ne bouge.
 *  2. La finance clique sur « Envoyer » : le remboursement est réservé (SENDING) avec son audit, PUIS
 *     Notch Pay (Transfers) est appelé. Deux clics ne peuvent pas envoyer deux fois.
 *  3. Notch Pay conclut (webhook ou « Vérifier ») : PAID (voyageur prévenu) ou FAILED (nouvel essai possible).
 * Même règle d'or contre le double envoi : en cas de doute, on ne réessaie jamais sans « Vérifier ».
 */
import { ConflictException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import type { PayoutStatus } from '../../prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PAYMENT_GATEWAY, type PaymentGateway, type PayoutChannel, type TransferState } from './interfaces/payment-gateway.interface.js';
import { isDefiniteRejection } from './payouts.service.js';
import { PAYOUT_CHANNELS } from './payout-phone.js';

const SENDABLE: PayoutStatus[] = ['TO_SEND', 'FAILED'];
const IN_FLIGHT: PayoutStatus[] = ['SENDING', 'PROCESSING'];
export const REFUND_REFERENCE_PREFIX = 'rf_';

@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  /** `open` : à rembourser, en cours, en échec. `done` : déjà remboursés (100 derniers). */
  async list(view: 'open' | 'done' = 'open') {
    const rows = await this.prisma.refund.findMany({
      where: view === 'done' ? { status: 'PAID' } : { status: { not: 'PAID' } },
      orderBy: view === 'done' ? { paidAt: 'desc' } : { createdAt: 'asc' },
      take: 100,
      include: { escrow: { select: { bookingId: true, booking: { select: { checkInDate: true, checkOutDate: true, room: { select: { name: true, property: { select: { title: true, city: true } } } } } } } } },
    });
    const ids = [...new Set(rows.map((r) => r.travelerId).filter((id): id is string => !!id))];
    const users = await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true, phone: true } });
    const byId = new Map(users.map((u) => [u.id, u]));
    return rows.map((row) => {
      const traveler = row.travelerId ? byId.get(row.travelerId) : undefined;
      const booking = row.escrow.booking;
      const hasNumber = !!row.beneficiaryPhone && (PAYOUT_CHANNELS as readonly string[]).includes(row.beneficiaryChannel ?? '');
      return {
        id: row.id,
        status: row.status,
        reason: row.reason,
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
        traveler: traveler ? { id: traveler.id, fullName: traveler.fullName, phone: traveler.phone } : null,
        beneficiary: row.beneficiaryPhone ? { channel: row.beneficiaryChannel, phone: row.beneficiaryPhone, accountName: row.beneficiaryName } : null,
        canSend: SENDABLE.includes(row.status) && hasNumber,
        canCheck: IN_FLIGHT.includes(row.status) && !!row.reference,
        canMarkPaid: SENDABLE.includes(row.status),
      };
    });
  }

  /** Clic sur « Envoyer ». L'issue est dans le remboursement renvoyé : aucune erreur après la réservation. */
  async send(refundId: string, actorId: string) {
    const refund = await this.prisma.refund.findUnique({
      where: { id: refundId },
      include: { escrow: { select: { bookingId: true, booking: { select: { room: { select: { property: { select: { title: true } } } } } } } } },
    });
    if (!refund) throw new NotFoundException('Remboursement introuvable.');
    if (!SENDABLE.includes(refund.status)) {
      throw new ConflictException(refund.status === 'PAID' ? 'Ce remboursement a déjà été effectué.' : 'Ce remboursement est déjà en cours : utilisez « Vérifier ».');
    }
    const channel = refund.beneficiaryChannel;
    if (!refund.beneficiaryPhone || !refund.beneficiaryName || !(PAYOUT_CHANNELS as readonly string[]).includes(channel ?? '')) {
      throw new ConflictException("Le voyageur n'a pas indiqué de numéro Mobile Money : on ne peut pas le rembourser par ce moyen.");
    }
    const beneficiary = { channel: channel as PayoutChannel, phone: refund.beneficiaryPhone, name: refund.beneficiaryName };
    const attempt = refund.attempts + 1;
    const reference = `${REFUND_REFERENCE_PREFIX}${refund.id}_${attempt}`;
    const amount = Number(refund.amount);

    const claimed = await this.prisma.$transaction(async (tx) => {
      const res = await tx.refund.updateMany({
        where: { id: refund.id, status: { in: SENDABLE }, attempts: refund.attempts },
        data: { status: 'SENDING', attempts: attempt, reference, gatewayRef: null, failureReason: null, sentById: actorId, sentAt: new Date() },
      });
      if (res.count === 0) return false;
      await tx.auditLog.create({
        data: { actorId, action: 'refund.send', targetType: 'Refund', targetId: refund.id, meta: { bookingId: refund.escrow.bookingId, amount, attempt, reference } },
      });
      return true;
    });
    if (!claimed) throw new ConflictException('Ce remboursement vient d’être pris en charge par quelqu’un d’autre.');

    try {
      const state = await this.gateway.sendTransfer({
        amount,
        currency: 'XAF',
        reference,
        description: `Remboursement SòôRooms — ${refund.escrow.booking.room.property.title}`.slice(0, 120),
        beneficiary,
      });
      await this.applyState(refund.id, state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Remboursement ${refund.id} (tentative ${attempt}) : ${message}`);
      if (isDefiniteRejection(error)) {
        await this.markFailed(refund.id, message);
      } else {
        await this.prisma.refund.updateMany({
          where: { id: refund.id, status: 'SENDING' },
          data: { failureReason: 'Réponse de Notch Pay inconnue : cliquez sur « Vérifier » avant tout nouvel essai.' },
        });
      }
    }
    return this.view(refund.id);
  }

  /** La finance a remboursé elle-même (hors Notch Pay) et saisit la preuve. Refusé si un envoi est en vol. */
  async markPaidManually(refundId: string, actorId: string, proof: string) {
    const refund = await this.prisma.refund.findUnique({ where: { id: refundId }, include: { escrow: { select: { bookingId: true } } } });
    if (!refund) throw new NotFoundException('Remboursement introuvable.');
    if (!SENDABLE.includes(refund.status)) {
      throw new ConflictException(refund.status === 'PAID' ? 'Ce remboursement a déjà été effectué.' : 'Un envoi Notch Pay est en cours : utilisez « Vérifier l’état » avant toute autre action.');
    }
    const reference = proof.trim().slice(0, 80);
    const amount = Number(refund.amount);
    const claimed = await this.prisma.$transaction(async (tx) => {
      const res = await tx.refund.updateMany({
        where: { id: refund.id, status: { in: SENDABLE }, attempts: refund.attempts },
        data: { status: 'SENDING', sentById: actorId, sentAt: new Date(), failureReason: null },
      });
      if (res.count === 0) return false;
      await tx.auditLog.create({
        data: { actorId, action: 'refund.manual_paid', targetType: 'Refund', targetId: refund.id, meta: { bookingId: refund.escrow.bookingId, amount, proof: reference } },
      });
      return true;
    });
    if (!claimed) throw new ConflictException('Ce remboursement vient d’être pris en charge par quelqu’un d’autre.');
    await this.applyState(refund.id, { status: 'COMPLETE', gatewayRef: `manuel:${reference}`, reference: refund.reference ?? `manuel_${refund.id}` });
    return this.view(refund.id);
  }

  async check(refundId: string, actorId: string) {
    const refund = await this.prisma.refund.findUnique({ where: { id: refundId } });
    if (!refund) throw new NotFoundException('Remboursement introuvable.');
    if (!IN_FLIGHT.includes(refund.status) || !refund.reference) throw new ConflictException("Ce remboursement n'a pas d'envoi à vérifier.");
    const state = await this.gateway.getTransfer(refund.reference);
    if (!state) {
      if (refund.status === 'SENDING') await this.markFailed(refund.id, "Notch Pay n'a pas reçu l'ordre d'envoi. Vous pouvez réessayer.");
      else throw new ConflictException('Notch Pay ne retrouve pas ce transfert : contactez Notch Pay avant de réessayer.');
    } else {
      await this.applyState(refund.id, state);
    }
    await this.prisma.auditLog.create({ data: { actorId, action: 'refund.check', targetType: 'Refund', targetId: refund.id } });
    return this.view(refund.id);
  }

  /** Webhook `transfer.*` d'un remboursement : on ne croit que la relecture directe chez Notch Pay. */
  async applyTransferEvent(reference: string) {
    const refund = await this.prisma.refund.findUnique({ where: { reference } });
    if (!refund) return { ignored: true };
    const state = await this.gateway.getTransfer(reference);
    if (!state || state.reference !== reference) throw new ConflictException("Transfert non confirmé par l'agrégateur.");
    await this.applyState(refund.id, state);
    return { processed: true };
  }

  private async view(refundId: string) {
    return (await this.list('open')).find((r) => r.id === refundId) ?? (await this.list('done')).find((r) => r.id === refundId) ?? null;
  }

  private async markFailed(refundId: string, reason: string) {
    const res = await this.prisma.refund.updateMany({
      where: { id: refundId, status: { in: IN_FLIGHT } },
      data: { status: 'FAILED', failureReason: reason.slice(0, 300) },
    });
    if (res.count > 0) await this.notifyFailure(refundId);
  }

  private async applyState(refundId: string, state: TransferState) {
    if (state.status === 'COMPLETE') {
      const paid = await this.prisma.$transaction(async (tx) => {
        const res = await tx.refund.updateMany({
          where: { id: refundId, status: { not: 'PAID' } },
          data: { status: 'PAID', paidAt: new Date(), gatewayRef: state.gatewayRef, failureReason: null },
        });
        if (res.count === 0) return null;
        const refund = await tx.refund.findUnique({
          where: { id: refundId },
          select: { escrowId: true, amount: true, travelerId: true, escrow: { select: { bookingId: true, booking: { select: { room: { select: { property: { select: { title: true } } } } } } } } },
        });
        if (!refund) return null;
        // Remboursement total (rien pour l'hôte) : le séquestre est soldé. Sinon, c'est le versement à l'hôte qui le solde.
        await tx.escrowVault.updateMany({ where: { id: refund.escrowId, status: 'HELD_IN_ESCROW', payout: { is: null } }, data: { status: 'REFUNDED_TO_TRAVELER' } });
        return refund;
      });
      if (paid?.travelerId && this.notifications) {
        await this.notifications.notify(paid.travelerId, 'REFUND_SENT', {
          bookingId: paid.escrow.bookingId,
          amount: Number(paid.amount),
          propertyTitle: paid.escrow.booking.room.property.title,
        });
      }
      return;
    }
    if (state.status === 'FAILED') {
      await this.markFailed(refundId, state.failureReason ?? 'Transfert refusé par Notch Pay.');
      return;
    }
    await this.prisma.refund.updateMany({ where: { id: refundId, status: 'SENDING' }, data: { status: 'PROCESSING', gatewayRef: state.gatewayRef, failureReason: null } });
  }

  private async notifyFailure(refundId: string) {
    if (!this.notifications) return;
    try {
      const r = await this.prisma.refund.findUnique({
        where: { id: refundId },
        select: { amount: true, escrow: { select: { booking: { select: { room: { select: { property: { select: { title: true } } } } } } } } },
      });
      if (!r) return;
      await this.notifications.notifyStaff('payouts.manage', 'REFUND_FAILED_STAFF', { amount: Number(r.amount), propertyTitle: r.escrow.booking.room.property.title });
    } catch (error) {
      this.logger.error(`Alerte d'échec de remboursement non envoyée : ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

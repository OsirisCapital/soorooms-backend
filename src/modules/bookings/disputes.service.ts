/**
 * Résolution des litiges par l'équipe (finance). Un litige gèle la réservation (DISPUTED) et les fonds
 * restent en séquestre ; ici l'équipe tranche :
 *  - REFUND_FULL    : tout est rendu au voyageur (réservation annulée) ;
 *  - REFUND_PARTIAL : une partie est rendue, le reste est conservé par l'hôte et la plateforme ;
 *  - PAY_HOST       : le litige est écarté, l'hôte est payé (réservation terminée).
 * Rien ne part automatiquement : un remboursement entre dans la file « Remboursements », un versement dans
 * la file « Versements » — la finance les envoie ensuite, comme pour toute annulation.
 */
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { can } from '../../common/utils/collaborator-access.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LoyaltyService } from '../loyalty/loyalty.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import type { ResolveDisputeDto } from './dto/resolve-dispute.dto.js';
import { splitForRefund } from './refund-policy.js';

@Injectable()
export class DisputesService {
  private readonly logger = new Logger(DisputesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly notifications: NotificationsService,
    @Optional() private readonly loyalty?: LoyaltyService,
  ) {}

  /** Litiges ouverts avec tout ce qu'il faut pour décider : motif, montants, état des files. */
  async list() {
    const rows = await this.prisma.booking.findMany({
      where: { status: 'DISPUTED' },
      orderBy: { updatedAt: 'asc' },
      select: {
        id: true,
        checkInDate: true,
        checkOutDate: true,
        totalPrice: true,
        disputeReason: true,
        travelerConfirmedAt: true,
        hostConfirmedAt: true,
        updatedAt: true,
        traveler: { select: { id: true, fullName: true, phone: true } },
        room: { select: { name: true, property: { select: { id: true, title: true, city: true, collaborators: { where: { role: 'MANAGER' }, select: { user: { select: { id: true, fullName: true, phone: true } } }, take: 1 } } } } },
        escrowVault: {
          select: {
            amountHeld: true, hostPayout: true, travelerFee: true, platformFee: true, status: true,
            transactions: { where: { transactionStatus: 'SUCCESS' }, select: { amount: true } },
          },
        },
      },
    });
    return rows.map((row) => {
      const escrow = row.escrowVault;
      const { collaborators, ...property } = row.room.property;
      return {
        id: row.id,
        checkInDate: row.checkInDate,
        checkOutDate: row.checkOutDate,
        totalPrice: row.totalPrice,
        disputeReason: row.disputeReason,
        travelerConfirmedAt: row.travelerConfirmedAt,
        hostConfirmedAt: row.hostConfirmedAt,
        openedAt: row.updatedAt,
        traveler: row.traveler,
        host: collaborators[0]?.user ?? null,
        room: { name: row.room.name, property },
        money: escrow
          ? {
              paid: escrow.transactions.reduce((sum, t) => sum + Number(t.amount), 0),
              hostPayout: Number(escrow.hostPayout),
              travelerFee: Number(escrow.travelerFee),
              status: escrow.status,
            }
          : null,
      };
    });
  }

  async resolve(bookingId: string, adminId: string, dto: ResolveDisputeDto) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true, status: true, travelerId: true,
        room: { select: { property: { select: { title: true, collaborators: { select: { userId: true, role: true } } } } } },
        escrowVault: {
          select: {
            id: true, status: true, amountHeld: true, hostPayout: true, travelerFee: true,
            payout: { select: { id: true } }, refund: { select: { id: true } },
            transactions: { where: { transactionStatus: 'SUCCESS' }, select: { amount: true } },
          },
        },
      },
    });
    if (!booking) throw new NotFoundException('Réservation introuvable.');
    if (booking.status !== 'DISPUTED') throw new ConflictException("Ce litige n'est plus ouvert.");
    const escrow = booking.escrowVault;
    if (!escrow) throw new ConflictException('Aucun paiement trouvé pour cette réservation.');
    if (escrow.status !== 'HELD_IN_ESCROW' || escrow.payout || escrow.refund) {
      throw new ConflictException('Les fonds de cette réservation ont déjà été traités.');
    }
    const paid = escrow.transactions.reduce((sum, t) => sum + Number(t.amount), 0);
    if (paid <= 0) throw new ConflictException("Aucun paiement encaissé : il n'y a rien à rembourser ni à verser.");

    let refund = 0;
    if (dto.decision === 'REFUND_FULL') refund = paid;
    if (dto.decision === 'REFUND_PARTIAL') {
      if (!dto.refundAmount || dto.refundAmount >= paid) {
        throw new BadRequestException(`Pour un remboursement partiel, indiquez un montant entre 1 et ${paid - 1} FCFA. Pour tout rendre, choisissez « Rembourser en totalité ».`);
      }
      refund = dto.refundAmount;
    }
    const split = splitForRefund({ paid, hostPayout: Number(escrow.hostPayout), travelerFee: Number(escrow.travelerFee), refund });
    const note = dto.note.trim();
    const nextStatus = dto.decision === 'PAY_HOST' ? 'COMPLETED' : 'CANCELLED';

    await this.prisma.$transaction(
      async (tx) => {
        const claimed = await tx.booking.updateMany({
          where: { id: booking.id, status: 'DISPUTED' },
          data: nextStatus === 'COMPLETED' ? { status: 'COMPLETED' } : { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: adminId, cancelReason: note },
        });
        if (claimed.count === 0) throw new ConflictException("Ce litige vient d'être tranché par quelqu'un d'autre.");
        await tx.auditLog.create({
          data: { actorId: adminId, action: 'dispute.resolve', targetType: 'Booking', targetId: booking.id, meta: { decision: dto.decision, paid, refund, hostPayout: split.hostPayout, note } },
        });
        if (dto.decision === 'PAY_HOST') return;
        await tx.escrowVault.update({
          where: { id: escrow.id },
          data: {
            amountHeld: split.retained,
            hostPayout: split.hostPayout,
            platformFee: split.retained - split.hostPayout,
            travelerFee: split.travelerFeeKept,
            ...(split.retained > 0 && split.hostPayout === 0 ? { status: 'RELEASED_TO_HOST' as const } : {}),
          },
        });
        await tx.refund.create({ data: { escrowId: escrow.id, travelerId: booking.travelerId, amount: refund, reason: 'DISPUTE' } });
      },
      { timeout: 15_000 },
    );

    // Part de l'hôte : file des versements (à valider par la finance).
    if (dto.decision === 'PAY_HOST' || split.hostPayout > 0) {
      try {
        await this.payments.releaseEscrow(booking.id);
      } catch (error) {
        this.logger.error(`Litige ${booking.id} : versement à l'hôte non mis en file (${error instanceof Error ? error.message : String(error)}). À traiter à la main.`);
      }
    }
    if (dto.decision === 'PAY_HOST') await this.loyalty?.awardForCompletedBooking(booking.id);

    const propertyTitle = booking.room.property.title;
    const payload = { bookingId: booking.id, propertyTitle, decision: dto.decision, refundAmount: refund, note };
    await this.notifications.notify(booking.travelerId, 'DISPUTE_RESOLVED', { ...payload, audience: 'traveler' });
    for (const c of booking.room.property.collaborators.filter((x) => can(x.role, 'bookings.manage'))) {
      await this.notifications.notify(c.userId, 'DISPUTE_RESOLVED', { ...payload, audience: 'host' });
    }
    if (refund > 0) await this.notifications.notifyStaff('payouts.manage', 'REFUND_TO_SEND_STAFF', { amount: refund, propertyTitle });
    return { ok: true, decision: dto.decision, refund, retained: split.retained, hostPayout: dto.decision === 'PAY_HOST' ? Number(escrow.hostPayout) : split.hostPayout };
  }
}

/**
 * Rapports financiers en lecture seule : un pour l'équipe finance (toute la plateforme), un pour
 * chaque hôte (uniquement les logements dont il est MANAGER). Les deux partent des mêmes lignes
 * (séquestre + paiement + versement) et des mêmes calculs (finance.utils.ts).
 */
import { forfeitedAmounts } from '../payments/deposit.utils.js';
import { rolesWith } from '../../common/utils/collaborator-access.js';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { bucketByDay, lastDayKeys, windowStart } from '../admin/stats.utils.js';
import { buildReport, type FinanceRow } from './finance.utils.js';

const DAY_MS = 24 * 3_600_000;
const toNumber = (value: { toString(): string } | null | undefined) => (value == null ? 0 : Number(value.toString()));

@Injectable()
export class FinanceService {
  constructor(private readonly prisma: PrismaService) {}

  /** Lignes utiles à la période : payées dans la fenêtre, changées dans la fenêtre, ou encore en séquestre. */
  private async loadRows(scope: Prisma.EscrowVaultWhereInput, since: Date): Promise<FinanceRow[]> {
    const escrows = await this.prisma.escrowVault.findMany({
      where: {
        AND: [
          scope,
          { transactions: { some: { transactionStatus: 'SUCCESS' } } },
          { OR: [{ createdAt: { gte: new Date(since.getTime() - DAY_MS) } }, { updatedAt: { gte: since } }, { status: 'HELD_IN_ESCROW' }] },
        ],
      },
      include: {
        transactions: { where: { transactionStatus: 'SUCCESS' }, orderBy: { createdAt: 'asc' }, take: 1, select: { createdAt: true, paymentMethod: true } },
        payout: { select: { status: true, paidAt: true } },
        booking: { select: { status: true, room: { select: { name: true, property: { select: { id: true, title: true, city: true } } } } } },
      },
    });

    return escrows.flatMap((escrow): FinanceRow[] => {
      const payment = escrow.transactions[0];
      if (!payment) return [];
      const property = escrow.booking.room.property;
      // Seul l'acompte est payé : on ne compte que sa part (au prorata de la commission).
      const partial = escrow.booking.status === 'DEPOSIT_PAID' && escrow.depositAmount != null ? forfeitedAmounts(escrow) : null;
      const closedAt = escrow.status === 'HELD_IN_ESCROW' ? null : escrow.status === 'RELEASED_TO_HOST' ? (escrow.payout?.paidAt ?? escrow.updatedAt) : escrow.updatedAt;
      return [
        {
          escrowId: escrow.id,
          bookingId: escrow.bookingId,
          propertyId: property.id,
          propertyTitle: property.title,
          city: property.city,
          roomName: escrow.booking.room.name,
          paidAt: payment.createdAt,
          closedAt,
          status: escrow.status,
          bookingStatus: escrow.booking.status,
          method: payment.paymentMethod,
          amount: partial ? partial.amountHeld : toNumber(escrow.amountHeld),
          fee: partial ? partial.platformFee : toNumber(escrow.platformFee),
          net: partial ? partial.hostPayout : toNumber(escrow.hostPayout),
          payoutStatus: escrow.payout?.status ?? null,
        },
      ];
    });
  }

  /** Équipe finance : tout ce que gagne la plateforme (commissions + boosts) et où est l'argent. */
  async adminReport(days: number, now = new Date()) {
    const keys = lastDayKeys(days, now);
    const since = windowStart(keys[0]);
    const [rows, boosts] = await Promise.all([
      this.loadRows({}, since),
      this.prisma.propertyBoost.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true, paidAmount: true } }),
    ]);

    const report = buildReport(rows, keys, 'fee');
    const boostItems = boosts.map((boost) => ({ date: boost.createdAt, value: toNumber(boost.paidAmount) }));
    const boostTotal = boostItems.reduce((total, item) => total + item.value, 0);
    const boostSeries = bucketByDay(boostItems, keys);

    return {
      generatedAt: now.toISOString(),
      ...report,
      period: { ...report.period, boosts: boostTotal, revenue: report.period.commissionEarned + boostTotal },
      series: { ...report.series, settled: report.series.settled.map((value, i) => value + boostSeries[i]) },
      byProperty: report.byProperty.slice(0, 10),
    };
  }

  /** Un hôte : uniquement les logements dont il est gérant principal ou comptable. Le net est ce qu'il reçoit, commission déduite. */
  async hostReport(userId: string, days: number, now = new Date()) {
    const keys = lastDayKeys(days, now);
    const since = windowStart(keys[0]);
    const rows = await this.loadRows({ booking: { room: { property: { collaborators: { some: { userId, role: { in: rolesWith('finance.view') } } } } } } }, since);
    const report = buildReport(rows, keys, 'net');
    return {
      generatedAt: now.toISOString(),
      ...report,
      period: { ...report.period, boosts: 0, revenue: report.period.hostNetReleased },
    };
  }
}

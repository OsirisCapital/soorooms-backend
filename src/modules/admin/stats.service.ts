/**
 * Chiffres du tableau de bord. Lecture seule. Les montants sont en FCFA.
 *
 * Les courbes sont calculées à partir des lignes de la période (au plus 90 jours) puis regroupées
 * par jour ici : simple et vérifiable à l'échelle actuelle. Si le volume devient important, ce
 * regroupement se fera dans la base (date_trunc) sans changer ce que renvoie l'API.
 */
import { Injectable } from '@nestjs/common';
import { BookingStatus, PropertyStatus } from '../../prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { bucketByDay, lastDayKeys, windowStart } from './stats.utils.js';

const DAY_MS = 24 * 3_600_000;
/** Réservations dont l'argent est réellement engagé : payées, en séquestre ou terminées. */
const PAID_STATUSES: BookingStatus[] = ['CONFIRMED_ESCROW', 'COMPLETED'];

const toNumber = (value: { toString(): string } | null | undefined) => (value == null ? 0 : Number(value.toString()));

function countsByStatus<T extends string>(all: readonly T[], rows: Array<{ status: T; _count: { _all: number } }>) {
  const result = Object.fromEntries(all.map((status) => [status, 0])) as Record<T, number>;
  for (const row of rows) result[row.status] = row._count._all;
  return result;
}

@Injectable()
export class StatsService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(now = new Date()) {
    const sevenDaysAgo = new Date(now.getTime() - 7 * DAY_MS);
    const fourteenDaysAgo = new Date(now.getTime() - 14 * DAY_MS);

    const [
      usersTotal,
      travelers,
      hosts,
      admins,
      newLast7Days,
      previous7Days,
      kycPending,
      propertiesByStatus,
      topCities,
      bookingsByStatus,
      volume,
      escrowHeld,
      feesEarned,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { role: 'TRAVELER' } }),
      this.prisma.user.count({ where: { role: 'HOST' } }),
      this.prisma.user.count({ where: { role: 'ADMIN' } }),
      this.prisma.user.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
      this.prisma.user.count({ where: { createdAt: { gte: fourteenDaysAgo, lt: sevenDaysAgo } } }),
      this.prisma.user.count({ where: { kycStatus: 'PENDING_REVIEW' } }),
      this.prisma.property.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.property.groupBy({ by: ['city'], _count: { _all: true }, orderBy: { _count: { city: 'desc' } }, take: 8 }),
      this.prisma.booking.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.booking.aggregate({ _sum: { totalPrice: true }, where: { status: { in: PAID_STATUSES } } }),
      this.prisma.escrowVault.aggregate({ _sum: { amountHeld: true }, where: { status: 'HELD_IN_ESCROW' } }),
      this.prisma.escrowVault.aggregate({ _sum: { platformFee: true }, where: { status: 'RELEASED_TO_HOST' } }),
    ]);

    const byBookingStatus = countsByStatus(Object.values(BookingStatus), bookingsByStatus);
    const byPropertyStatus = countsByStatus(Object.values(PropertyStatus), propertiesByStatus);

    return {
      generatedAt: now.toISOString(),
      users: { total: usersTotal, travelers, hosts, admins, newLast7Days, previous7Days },
      kyc: { pending: kycPending },
      properties: {
        total: Object.values(byPropertyStatus).reduce((a, b) => a + b, 0),
        byStatus: byPropertyStatus,
        topCities: topCities.map((row) => ({ city: row.city, count: row._count._all })),
      },
      bookings: {
        total: Object.values(byBookingStatus).reduce((a, b) => a + b, 0),
        byStatus: byBookingStatus,
        disputed: byBookingStatus.DISPUTED,
      },
      money: {
        volumeBooked: toNumber(volume._sum.totalPrice),
        heldInEscrow: toNumber(escrowHeld._sum.amountHeld),
        platformFeesEarned: toNumber(feesEarned._sum.platformFee),
      },
    };
  }

  /** `days` jours (7 à 90) se terminant aujourd'hui : inscriptions, réservations créées, montant réservé. */
  async timeseries(days: number, now = new Date()) {
    const keys = lastDayKeys(days, now);
    const since = windowStart(keys[0]);

    const [users, bookings] = await Promise.all([
      this.prisma.user.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true } }),
      this.prisma.booking.findMany({
        where: { createdAt: { gte: since } },
        select: { createdAt: true, status: true, totalPrice: true },
      }),
    ]);

    return {
      days: keys,
      signups: bucketByDay(
        users.map((user) => ({ date: user.createdAt })),
        keys,
      ),
      bookings: bucketByDay(
        bookings.map((booking) => ({ date: booking.createdAt })),
        keys,
      ),
      volume: bucketByDay(
        bookings
          .filter((booking) => PAID_STATUSES.includes(booking.status))
          .map((booking) => ({ date: booking.createdAt, value: toNumber(booking.totalPrice) })),
        keys,
      ),
    };
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { EARNING_RULES, UPCOMING_USES, pointsToAward } from './loyalty.utils.js';

@Injectable()
export class LoyaltyService {
  private readonly logger = new Logger(LoyaltyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Crédite les points d'un séjour terminé. Idempotent : (réservation, motif) est unique en base, donc
   * rejouer la confirmation ne crédite rien de plus. Ne lève jamais : les points ne doivent pas bloquer
   * la clôture d'une réservation.
   */
  async awardForCompletedBooking(bookingId: string): Promise<void> {
    try {
      const booking = await this.prisma.booking.findUnique({
        where: { id: bookingId },
        select: { travelerId: true, totalPrice: true, room: { select: { property: { select: { title: true } } } } },
      });
      if (!booking || booking.totalPrice == null) return;
      const earlier = await this.prisma.loyaltyEntry.count({
        where: { userId: booking.travelerId, reason: 'STAY_COMPLETED', NOT: { bookingId } },
      });
      const lines = pointsToAward(Number(booking.totalPrice), earlier === 0);
      if (lines.length === 0) return;
      await this.prisma.loyaltyEntry.createMany({
        data: lines.map((l) => ({
          userId: booking.travelerId,
          points: l.points,
          reason: l.reason,
          bookingId,
          label: booking.room.property.title,
        })),
        skipDuplicates: true,
      });
    } catch (error) {
      this.logger.error(`Points non crédités (réservation ${bookingId}) : ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async summary(userId: string) {
    const [total, entries] = await Promise.all([
      this.prisma.loyaltyEntry.aggregate({ where: { userId }, _sum: { points: true } }),
      this.prisma.loyaltyEntry.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { id: true, points: true, reason: true, label: true, bookingId: true, createdAt: true },
      }),
    ]);
    return {
      balance: total._sum.points ?? 0,
      entries,
      rules: EARNING_RULES,
      upcomingUses: UPCOMING_USES,
    };
  }
}

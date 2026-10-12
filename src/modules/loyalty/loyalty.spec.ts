import { describe, expect, it, vi } from 'vitest';
import { LoyaltyService } from './loyalty.service.js';
import { FIRST_STAY_BONUS, pointsToAward, stayPoints } from './loyalty.utils.js';

describe('barème des points', () => {
  it('1 point par tranche de 1 000 FCFA, arrondi à l’inférieur', () => {
    expect(stayPoints(100_000)).toBe(100);
    expect(stayPoints(45_900)).toBe(45);
    expect(stayPoints(999)).toBe(0);
    expect(stayPoints(0)).toBe(0);
    expect(stayPoints(Number.NaN)).toBe(0);
  });

  it('le bonus du premier séjour s’ajoute une fois', () => {
    expect(pointsToAward(100_000, true)).toEqual([
      { reason: 'STAY_COMPLETED', points: 100 },
      { reason: 'FIRST_STAY_BONUS', points: FIRST_STAY_BONUS },
    ]);
    expect(pointsToAward(100_000, false)).toEqual([{ reason: 'STAY_COMPLETED', points: 100 }]);
    expect(pointsToAward(500, false)).toEqual([]);
  });
});

function setup(earlier = 0, booking: unknown = { travelerId: 'u1', totalPrice: 250_000, room: { property: { title: 'Villa Kribi' } } }) {
  const prisma = {
    booking: { findUnique: vi.fn().mockResolvedValue(booking) },
    loyaltyEntry: {
      count: vi.fn().mockResolvedValue(earlier),
      createMany: vi.fn().mockResolvedValue({ count: 2 }),
      aggregate: vi.fn().mockResolvedValue({ _sum: { points: 350 } }),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
  return { service: new LoyaltyService(prisma as never), prisma };
}

describe('LoyaltyService', () => {
  it('crédite le séjour et le bonus du premier séjour, sans doublon possible', async () => {
    const { service, prisma } = setup(0);
    await service.awardForCompletedBooking('b1');
    expect(prisma.loyaltyEntry.createMany).toHaveBeenCalledWith({
      data: [
        { userId: 'u1', points: 250, reason: 'STAY_COMPLETED', bookingId: 'b1', label: 'Villa Kribi' },
        { userId: 'u1', points: 100, reason: 'FIRST_STAY_BONUS', bookingId: 'b1', label: 'Villa Kribi' },
      ],
      skipDuplicates: true,
    });
  });

  it('pas de bonus quand un séjour a déjà été terminé', async () => {
    const { service, prisma } = setup(2);
    await service.awardForCompletedBooking('b1');
    expect(prisma.loyaltyEntry.createMany.mock.calls[0][0].data).toHaveLength(1);
  });

  it('ne lève jamais, même si la base échoue', async () => {
    const { service, prisma } = setup();
    prisma.loyaltyEntry.createMany.mockRejectedValue(new Error('base indisponible'));
    await expect(service.awardForCompletedBooking('b1')).resolves.toBeUndefined();
  });

  it('ignore une réservation sans prix', async () => {
    const { service, prisma } = setup(0, { travelerId: 'u1', totalPrice: null, room: { property: { title: 'X' } } });
    await service.awardForCompletedBooking('b1');
    expect(prisma.loyaltyEntry.createMany).not.toHaveBeenCalled();
  });

  it('le résumé donne solde, règles et usages à venir', async () => {
    const { service } = setup();
    const s = await service.summary('u1');
    expect(s.balance).toBe(350);
    expect(s.rules.length).toBeGreaterThan(0);
    expect(s.upcomingUses.length).toBeGreaterThan(0);
  });
});

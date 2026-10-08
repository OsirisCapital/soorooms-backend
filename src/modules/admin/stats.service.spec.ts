import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { StatsService } from './stats.service.js';

const NOW = new Date('2026-10-08T12:00:00Z');
const dec = (value: number) => ({ toString: () => String(value) });

function makePrisma(overrides: Record<string, unknown> = {}) {
  return {
    user: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    property: { groupBy: vi.fn().mockResolvedValue([]) },
    booking: {
      groupBy: vi.fn().mockResolvedValue([]),
      aggregate: vi.fn().mockResolvedValue({ _sum: { totalPrice: null } }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    escrowVault: { aggregate: vi.fn().mockResolvedValue({ _sum: {} }) },
    ...overrides,
  };
}

describe('StatsService.overview', () => {
  it('base vide : tout vaut 0 et chaque statut est présent', async () => {
    const result = await new StatsService(makePrisma() as unknown as PrismaService).overview(NOW);

    expect(result.users.total).toBe(0);
    expect(result.bookings.total).toBe(0);
    expect(result.bookings.byStatus).toEqual({
      NEGOTIATING: 0, PENDING_PAYMENT: 0, CONFIRMED_ESCROW: 0, COMPLETED: 0, DISPUTED: 0, CANCELLED: 0,
    });
    expect(result.properties.byStatus).toEqual({ PENDING_KYC: 0, ACTIVE: 0, SUSPENDED: 0 });
    expect(result.money).toEqual({ volumeBooked: 0, heldInEscrow: 0, platformFeesEarned: 0 });
  });

  it('rassemble les comptes, les statuts et les montants', async () => {
    const prisma = makePrisma();
    prisma.booking.groupBy.mockResolvedValue([
      { status: 'COMPLETED', _count: { _all: 4 } },
      { status: 'DISPUTED', _count: { _all: 1 } },
    ]);
    prisma.property.groupBy
      .mockResolvedValueOnce([{ status: 'ACTIVE', _count: { _all: 6 } }])
      .mockResolvedValueOnce([{ city: 'Douala', _count: { _all: 5 } }, { city: 'Kribi', _count: { _all: 1 } }]);
    prisma.booking.aggregate.mockResolvedValue({ _sum: { totalPrice: dec(250000) } });
    prisma.escrowVault.aggregate
      .mockResolvedValueOnce({ _sum: { amountHeld: dec(90000) } })
      .mockResolvedValueOnce({ _sum: { platformFee: dec(12500) } });

    const result = await new StatsService(prisma as unknown as PrismaService).overview(NOW);

    expect(result.bookings.total).toBe(5);
    expect(result.bookings.disputed).toBe(1);
    expect(result.properties.total).toBe(6);
    expect(result.properties.topCities).toEqual([{ city: 'Douala', count: 5 }, { city: 'Kribi', count: 1 }]);
    expect(result.money).toEqual({ volumeBooked: 250000, heldInEscrow: 90000, platformFeesEarned: 12500 });
  });

  it("le volume ne compte que les réservations dont l'argent est engagé", async () => {
    const prisma = makePrisma();
    await new StatsService(prisma as unknown as PrismaService).overview(NOW);
    expect(prisma.booking.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: { in: ['CONFIRMED_ESCROW', 'COMPLETED'] } } }),
    );
  });
});

describe('StatsService.timeseries', () => {
  it('renvoie une valeur par jour pour chaque courbe, le volume ne comptant que les réservations payées', async () => {
    const prisma = makePrisma();
    prisma.user.findMany.mockResolvedValue([{ createdAt: new Date('2026-10-08T08:00:00Z') }]);
    prisma.booking.findMany.mockResolvedValue([
      { createdAt: new Date('2026-10-07T09:00:00Z'), status: 'COMPLETED', totalPrice: dec(30000) },
      { createdAt: new Date('2026-10-07T10:00:00Z'), status: 'CANCELLED', totalPrice: dec(99000) },
      { createdAt: new Date('2026-10-08T10:00:00Z'), status: 'NEGOTIATING', totalPrice: null },
    ]);

    const result = await new StatsService(prisma as unknown as PrismaService).timeseries(7, NOW);

    expect(result.days).toHaveLength(7);
    expect(result.days.at(-1)).toBe('2026-10-08');
    expect(result.signups.at(-1)).toBe(1);
    expect(result.bookings.slice(-2)).toEqual([2, 1]);
    expect(result.volume.slice(-2)).toEqual([30000, 0]);
  });

  it('ne lit que les lignes de la fenêtre demandée', async () => {
    const prisma = makePrisma();
    await new StatsService(prisma as unknown as PrismaService).timeseries(7, NOW);
    const since = prisma.user.findMany.mock.calls[0][0].where.createdAt.gte as Date;
    expect(since.toISOString()).toBe('2026-10-01T23:00:00.000Z'); // minuit du 2 octobre au Cameroun
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import type { PaymentsService } from '../payments/payments.service.js';
import { BookingsService } from './bookings.service.js';

const HOST = 'host-1';
const TRAVELER = 'traveler-1';
const DTO = { roomId: 'room-1', checkInDate: '2099-01-10', checkOutDate: '2099-01-12' } as never;

function setup(opts: { openCount?: number; offerAgeMs?: number } = {}) {
  const property = { title: 'Villa', status: 'ACTIVE', collaborators: [{ userId: HOST, role: 'MANAGER' }] };
  const booking = {
    id: 'b1',
    roomId: 'room-1',
    travelerId: TRAVELER,
    status: 'NEGOTIATING',
    checkInDate: new Date('2099-01-10'),
    checkOutDate: new Date('2099-01-12'),
    room: { name: 'Ch', property },
    offers: [{ id: 'o1', proposedByUserId: TRAVELER, amount: 1000, createdAt: new Date(Date.now() - (opts.offerAgeMs ?? 0)) }],
  };
  const stale = (opts.offerAgeMs ?? 0) >= 2 * 3_600_000;
  const tx = {
    priceOffer: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), create: vi.fn() },
    booking: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), create: vi.fn().mockResolvedValue({ id: 'b1' }) },
  };
  const prisma = {
    room: { findUnique: vi.fn().mockResolvedValue({ id: 'room-1', basePrice: 1000, unitCount: 1, property }) },
    booking: {
      findUnique: vi.fn().mockResolvedValue(booking),
      findMany: vi.fn().mockImplementation(async (a: { where: { status?: unknown } }) => (a.where.status === 'NEGOTIATING' && stale ? [booking] : [])),
      count: vi.fn().mockResolvedValue(opts.openCount ?? 0),
    },
    user: { findUnique: vi.fn().mockResolvedValue({ fullName: 'M' }) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const notifications = { notify: vi.fn().mockResolvedValue(true), notifyMany: vi.fn(), notifyStaff: vi.fn() };
  const service = new BookingsService(prisma as unknown as PrismaService, {} as PaymentsService, notifications as unknown as NotificationsService);
  return { service, notifications, tx };
}

describe('BookingsService — délai de réponse et quota', () => {
  it('refuse une 4e demande ouverte', async () => {
    await expect(setup({ openCount: 3 }).service.create(TRAVELER, DTO)).rejects.toThrow(/3 demandes en attente/);
  });

  it('accepte une demande tant que le quota n’est pas atteint', async () => {
    const { service } = setup({ openCount: 2 });
    vi.spyOn(service, 'findOne').mockResolvedValue({} as never);
    await expect(service.create(TRAVELER, DTO)).resolves.toBeDefined();
  });

  it('une offre restée 2 h sans réponse expire : annulation, prévenance des deux parties, action refusée', async () => {
    const { service, notifications, tx } = setup({ offerAgeMs: 3 * 3_600_000 });
    await expect(service.acceptOffer('b1', HOST)).rejects.toThrow(/a expiré/);
    expect(tx.booking.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'CANCELLED' } }));
    const sent = notifications.notify.mock.calls.map((c) => [c[0], c[1]]);
    expect(sent).toContainEqual([TRAVELER, 'BOOKING_EXPIRED']);
    expect(sent).toContainEqual([HOST, 'BOOKING_EXPIRED']);
  });
});

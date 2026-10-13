import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import type { PaymentsService } from '../payments/payments.service.js';
import { BookingsService } from './bookings.service.js';

const DTO = { roomId: 'room-1', checkInDate: '2099-01-10', checkOutDate: '2099-01-12', proposedPrice: 28000 } as never;
const stay = { checkInDate: new Date('2099-01-09'), checkOutDate: new Date('2099-01-13') };

function setup(unitCount: number, stays: unknown[]) {
  const tx = {
    roomBlock: { findMany: vi.fn().mockResolvedValue([]) },
    booking: { create: vi.fn().mockResolvedValue({ id: 'b1' }) },
    priceOffer: { create: vi.fn() },
  };
  const prisma = {
    roomBlock: { findMany: vi.fn().mockResolvedValue([]) },
    room: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'room-1',
        basePrice: 15000,
        unitCount,
        property: { status: 'ACTIVE', title: 'Villa', collaborators: [] },
      }),
    },
    booking: {
      // Les demandes périmées (statut NEGOTIATING) : aucune ; sinon les séjours qui bloquent.
      findMany: vi.fn().mockImplementation(async (a: { where: { status?: unknown } }) => (a.where.status === 'NEGOTIATING' ? [] : stays)),
      count: vi.fn().mockResolvedValue(0),
    },
    user: { findUnique: vi.fn().mockResolvedValue({ fullName: 'Marie' }) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const notifications = { notify: vi.fn().mockResolvedValue(true), notifyMany: vi.fn(), notifyStaff: vi.fn() };
  const service = new BookingsService(prisma as unknown as PrismaService, {} as PaymentsService, notifications as unknown as NotificationsService);
  vi.spyOn(service, 'findOne').mockResolvedValue({} as never);
  return { service, tx };
}

describe('BookingsService — disponibilité par unités', () => {
  it('refuse quand toutes les unités du type sont prises', async () => {
    const { service } = setup(2, [stay, stay]);
    await expect(service.create('t1', DTO)).rejects.toThrow(/plus disponibles/);
  });

  it('accepte tant qu’il reste une unité', async () => {
    const { service, tx } = setup(2, [stay]);
    await service.create('t1', DTO);
    expect(tx.booking.create).toHaveBeenCalled();
  });

  it('un type à une unité garde l’ancien comportement', async () => {
    const { service } = setup(1, [stay]);
    await expect(service.create('t1', DTO)).rejects.toThrow(/plus disponibles/);
  });
});

describe('BookingsService — réservation pour une autre personne', () => {
  it('enregistre l’occupant sans changer le payeur', async () => {
    const { service, tx } = setup(2, []);
    await service.create('t1', { ...(DTO as object), guestName: '  Paul Ngo ', guestPhone: '6 70 00 00 00' } as never);
    expect(tx.booking.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ travelerId: 't1', guestName: 'Paul Ngo', guestPhone: '6 70 00 00 00' }),
    });
  });
});

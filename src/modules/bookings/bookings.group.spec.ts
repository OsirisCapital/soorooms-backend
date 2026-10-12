import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import type { PaymentsService } from '../payments/payments.service.js';
import { peakOccupancy, unitsLeft } from '../rooms/availability.utils.js';
import { BookingsService } from './bookings.service.js';

const DTO = { roomId: 'room-1', checkInDate: '2099-03-06', checkOutDate: '2099-03-09', units: 3 };

function setup(existing: { checkInDate: Date; checkOutDate: Date; units: number }[] = []) {
  const tx = { booking: { create: vi.fn().mockResolvedValue({ id: 'b1' }) }, priceOffer: { create: vi.fn() } };
  const prisma = {
    room: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'room-1', propertyId: 'p1', basePrice: 20000, unitCount: 5, maxGuests: 2,
        property: { status: 'ACTIVE', title: 'Hôtel Lac', propertyType: 'HOTEL', collaborators: [] },
      }),
    },
    booking: { findMany: vi.fn(async (args: { where?: { roomId?: string } }) => (args?.where?.roomId ? existing : [])), count: vi.fn().mockResolvedValue(0) },
    user: { findUnique: vi.fn().mockResolvedValue({ fullName: 'Marie' }) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const notifications = { notify: vi.fn(), notifyMany: vi.fn(), notifyStaff: vi.fn() };
  const service = new BookingsService(prisma as unknown as PrismaService, {} as PaymentsService, notifications as unknown as NotificationsService);
  vi.spyOn(service, 'findOne').mockResolvedValue({} as never);
  return { service, tx };
}

describe('disponibilité avec réservations de groupe', () => {
  it('une réservation de 3 chambres occupe 3 unités', () => {
    const stays = [{ checkInDate: new Date('2099-03-06'), checkOutDate: new Date('2099-03-09'), units: 3 }];
    expect(peakOccupancy(stays, new Date('2099-03-06'), new Date('2099-03-09'))).toBe(3);
    expect(unitsLeft(5, stays, new Date('2099-03-06'), new Date('2099-03-09'))).toBe(2);
  });
});

describe('BookingsService — réservation de groupe', () => {
  it('multiplie le prix par le nombre de chambres et enregistre units', async () => {
    const { service, tx } = setup();
    await service.create('t1', DTO as never);
    expect(tx.booking.create.mock.calls[0][0].data.units).toBe(3);
    expect(tx.priceOffer.create).toHaveBeenCalledWith({ data: expect.objectContaining({ amount: 20000 * 3 * 3 }) });
  });

  it('refuse plus de chambres que le type n’en compte', async () => {
    await expect(setup().service.create('t1', { ...DTO, units: 6 } as never)).rejects.toThrow(/5 chambres/);
  });

  it('refuse si il ne reste pas assez de chambres sur les dates', async () => {
    const taken = [{ checkInDate: new Date('2099-03-07'), checkOutDate: new Date('2099-03-08'), units: 3 }];
    await expect(setup(taken).service.create('t1', DTO as never)).rejects.toThrow(/Il ne reste que 2 chambres/);
  });
});

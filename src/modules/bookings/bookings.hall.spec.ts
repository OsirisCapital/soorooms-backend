import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import type { PaymentsService } from '../payments/payments.service.js';
import { BookingsService } from './bookings.service.js';

const OPT = '3f9a1c2b-0000-4000-8000-000000000001';
const DTO = { roomId: 'room-1', checkInDate: '2099-03-06', eventType: 'Mariage', eventSlot: 'EVENING', eventGuests: 200, optionIds: [OPT] };

function setup(options: unknown[] = [{ id: OPT, name: 'Sono', price: 50000 }]) {
  const tx = { booking: { create: vi.fn().mockResolvedValue({ id: 'b1' }) }, priceOffer: { create: vi.fn() } };
  const prisma = {
    roomBlock: { findMany: vi.fn().mockResolvedValue([]) },
    room: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'room-1', propertyId: 'p1', basePrice: 300000, unitCount: 1, maxGuests: 250,
        property: { status: 'ACTIVE', title: 'Salle Prestige', propertyType: 'EVENT_HALL', collaborators: [] },
      }),
    },
    hallOption: { findMany: vi.fn().mockResolvedValue(options) },
    booking: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    user: { findUnique: vi.fn().mockResolvedValue({ fullName: 'Marie' }) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const notifications = { notify: vi.fn(), notifyMany: vi.fn(), notifyStaff: vi.fn() };
  const service = new BookingsService(prisma as unknown as PrismaService, {} as PaymentsService, notifications as unknown as NotificationsService);
  vi.spyOn(service, 'findOne').mockResolvedValue({} as never);
  return { service, tx, prisma };
}

describe('BookingsService — salle de fêtes', () => {
  it('réserve une date, fige les options et propose tarif + options', async () => {
    const { service, tx } = setup();
    await service.create('t1', DTO as never);
    const data = tx.booking.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ eventType: 'Mariage', eventSlot: 'EVENING', eventGuests: 200, eventOptions: [{ id: OPT, name: 'Sono', price: 50000 }] });
    expect(data.checkOutDate.getTime() - data.checkInDate.getTime()).toBe(24 * 3_600_000);
    expect(tx.priceOffer.create).toHaveBeenCalledWith({ data: expect.objectContaining({ amount: 350000 }) });
  });

  it('exige type, créneau et invités', async () => {
    await expect(setup().service.create('t1', { ...DTO, eventType: undefined } as never)).rejects.toThrow(/type d'événement/);
  });

  it('refuse plus d’invités que la capacité', async () => {
    await expect(setup().service.create('t1', { ...DTO, eventGuests: 300 } as never)).rejects.toThrow(/250 personnes/);
  });

  it('refuse une option d’une autre salle', async () => {
    await expect(setup([]).service.create('t1', DTO as never)).rejects.toThrow(/options/);
  });
});

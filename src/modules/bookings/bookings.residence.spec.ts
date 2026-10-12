import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import type { PaymentsService } from '../payments/payments.service.js';
import { BookingsService } from './bookings.service.js';

const DTO = { roomId: 'room-1', checkInDate: '2099-09-15', stayTerm: 'SEMESTER' };

function setup(room: Record<string, unknown> = {}) {
  const tx = { booking: { create: vi.fn().mockResolvedValue({ id: 'b1' }) }, priceOffer: { create: vi.fn() } };
  const prisma = {
    room: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'room-1', propertyId: 'p1', basePrice: 90000, semesterPrice: 450000, yearPrice: 800000, unitCount: 4, maxGuests: 1,
        property: { status: 'ACTIVE', title: 'Foyer Bastos', propertyType: 'STUDENT_RESIDENCE', collaborators: [] },
        ...room,
      }),
    },
    booking: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    user: { findUnique: vi.fn().mockResolvedValue({ fullName: 'Awa' }) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const notifications = { notify: vi.fn(), notifyMany: vi.fn(), notifyStaff: vi.fn() };
  const service = new BookingsService(prisma as unknown as PrismaService, {} as PaymentsService, notifications as unknown as NotificationsService);
  vi.spyOn(service, 'findOne').mockResolvedValue({} as never);
  return { service, tx };
}

describe('BookingsService — résidence étudiante', () => {
  it('réserve un semestre : fin à +6 mois, prix du forfait', async () => {
    const { service, tx } = setup();
    await service.create('t1', DTO as never);
    const data = tx.booking.create.mock.calls[0][0].data;
    expect(data.stayTerm).toBe('SEMESTER');
    expect(data.checkOutDate.toISOString().slice(0, 10)).toBe('2100-03-15');
    expect(tx.priceOffer.create).toHaveBeenCalledWith({ data: expect.objectContaining({ amount: 450000 }) });
  });

  it('réserve une année au prix annuel', async () => {
    const { service, tx } = setup();
    await service.create('t1', { ...DTO, stayTerm: 'YEAR' } as never);
    expect(tx.booking.create.mock.calls[0][0].data.checkOutDate.toISOString().slice(0, 10)).toBe('2100-09-15');
    expect(tx.priceOffer.create).toHaveBeenCalledWith({ data: expect.objectContaining({ amount: 800000 }) });
  });

  it('exige le forfait', async () => {
    await expect(setup().service.create('t1', { ...DTO, stayTerm: undefined } as never)).rejects.toThrow(/forfait/);
  });

  it('refuse un forfait non proposé', async () => {
    await expect(setup({ yearPrice: null }).service.create('t1', { ...DTO, stayTerm: 'YEAR' } as never)).rejects.toThrow(/pas proposé/);
  });
});

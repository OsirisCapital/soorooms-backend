import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import type { PaymentsService } from '../payments/payments.service.js';
import { BookingsService } from './bookings.service.js';
import { extrasTotal } from './extras.utils.js';

const NAVETTE = '3f9a1c2b-0000-4000-8000-000000000001';
const PDEJ = '3f9a1c2b-0000-4000-8000-000000000002';
const DTO = { roomId: 'room-1', checkInDate: '2099-03-06', checkOutDate: '2099-03-09', optionIds: [NAVETTE, PDEJ] };
const OPTIONS = [
  { id: NAVETTE, name: 'Navette aéroport', price: 10000, perNight: false },
  { id: PDEJ, name: 'Petit-déjeuner', price: 2000, perNight: true },
];

function setup(type = 'HOTEL', options: unknown[] = OPTIONS) {
  const tx = { booking: { create: vi.fn().mockResolvedValue({ id: 'b1' }) }, priceOffer: { create: vi.fn() } };
  const prisma = {
    room: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'room-1', propertyId: 'p1', basePrice: 20000, unitCount: 5, maxGuests: 2, semesterPrice: 1, yearPrice: 1,
        property: { status: 'ACTIVE', title: 'Hôtel Lac', propertyType: type, collaborators: [] },
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
  return { service, tx };
}

describe('extras payants', () => {
  it('une fois ou par nuit', () => {
    expect(extrasTotal(OPTIONS, 3)).toBe(10000 + 2000 * 3);
    expect(extrasTotal([], 3)).toBe(0);
    expect(extrasTotal(OPTIONS, 0)).toBe(12000);
  });

  it('ajoute les extras au prix du séjour et les fige dans la réservation', async () => {
    const { service, tx } = setup();
    await service.create('t1', DTO as never);
    // 3 nuits × 20 000 + navette 10 000 + petit-déjeuner 3 × 2 000
    expect(tx.priceOffer.create).toHaveBeenCalledWith({ data: expect.objectContaining({ amount: 60000 + 10000 + 6000 }) });
    expect(tx.booking.create.mock.calls[0][0].data.extras).toEqual(OPTIONS);
  });

  it('refuse une option qui n’existe plus ou d’un autre logement', async () => {
    await expect(setup('HOTEL', [OPTIONS[0]]).service.create('t1', DTO as never)).rejects.toThrow(/n'existe plus/);
  });

  it('pas d’extras pour une résidence étudiante', async () => {
    await expect(setup('STUDENT_RESIDENCE').service.create('t1', { ...DTO, stayTerm: 'SEMESTER' } as never)).rejects.toThrow(/résidence/);
  });

  it('sans option, le prix est inchangé et rien n’est enregistré', async () => {
    const { service, tx } = setup();
    await service.create('t1', { ...DTO, optionIds: undefined } as never);
    expect(tx.priceOffer.create).toHaveBeenCalledWith({ data: expect.objectContaining({ amount: 60000 }) });
    expect(tx.booking.create.mock.calls[0][0].data.extras).toBeUndefined();
  });
});

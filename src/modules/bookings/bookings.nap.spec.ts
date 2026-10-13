import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import type { PaymentsService } from '../payments/payments.service.js';
import { BookingsService } from './bookings.service.js';

type Row = { checkInDate: Date; checkOutDate: Date; units?: number; napStartHour?: number | null; napHours?: number | null };

function setup(opts: { room?: Record<string, unknown>; existing?: Row[]; type?: string } = {}) {
  const tx = { booking: { create: vi.fn().mockResolvedValue({ id: 'b1' }) }, priceOffer: { create: vi.fn() } };
  const prisma = {
    roomBlock: { findMany: vi.fn().mockResolvedValue([]) },
    room: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'room-1', propertyId: 'p1', basePrice: 20000, unitCount: 1, maxGuests: 2,
        allowsNap: true, napPrice: 6000, napHours: 3, napBulb: false,
        property: { status: 'ACTIVE', title: 'Hôtel Lac', propertyType: opts.type ?? 'HOTEL', collaborators: [] },
        ...opts.room,
      }),
    },
    booking: { findMany: vi.fn(async (args: { where?: { roomId?: string } }) => (args?.where?.roomId ? (opts.existing ?? []) : [])), count: vi.fn().mockResolvedValue(0) },
    hallOption: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findUnique: vi.fn().mockResolvedValue({ fullName: 'Marie' }) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const notifications = { notify: vi.fn(), notifyMany: vi.fn(), notifyStaff: vi.fn() };
  const service = new BookingsService(prisma as unknown as PrismaService, {} as PaymentsService, notifications as unknown as NotificationsService);
  vi.spyOn(service, 'findOne').mockResolvedValue({} as never);
  return { service, tx };
}

const NAP = { roomId: 'room-1', checkInDate: '2099-03-06', nap: true, napStartHour: 15 };

describe('BookingsService — siestes', () => {
  it('crée une sieste au tarif de sieste, sur la journée, avec heure et durée', async () => {
    const { service, tx } = setup();
    await service.create('t1', NAP as never);
    const data = tx.booking.create.mock.calls[0][0].data;
    expect(data.napStartHour).toBe(15);
    expect(data.napHours).toBe(3);
    expect(data.checkOutDate.getTime() - data.checkInDate.getTime()).toBe(24 * 3_600_000);
    expect(tx.priceOffer.create).toHaveBeenCalledWith({ data: expect.objectContaining({ amount: 6000 }) });
  });

  it('refuse si la chambre n’accepte pas les siestes', async () => {
    await expect(setup({ room: { allowsNap: false } }).service.create('t1', NAP as never)).rejects.toThrow(/n'accepte pas les siestes/);
  });

  it('refuse l’heure de début manquante et une sieste qui passe minuit', async () => {
    await expect(setup().service.create('t1', { ...NAP, napStartHour: undefined } as never)).rejects.toThrow(/heure de début/);
    await expect(setup().service.create('t1', { ...NAP, napStartHour: 22 } as never)).rejects.toThrow(/minuit/);
  });

  it('refuse un créneau déjà pris par une autre sieste', async () => {
    const taken: Row[] = [{ checkInDate: new Date('2099-03-06'), checkOutDate: new Date('2099-03-07'), napStartHour: 16, napHours: 3 }];
    await expect(setup({ existing: taken }).service.create('t1', NAP as never)).rejects.toThrow(/pas libre sur ce créneau/);
  });

  it('refuse un créneau occupé par un séjour de nuit en cours', async () => {
    const stay: Row[] = [{ checkInDate: new Date('2099-03-05'), checkOutDate: new Date('2099-03-07') }];
    await expect(setup({ existing: stay }).service.create('t1', NAP as never)).rejects.toThrow(/pas libre sur ce créneau/);
  });

  it('accepte une sieste dès midi le jour du départ, refuse avant (le client est encore là)', async () => {
    const stay: Row[] = [{ checkInDate: new Date('2099-03-05'), checkOutDate: new Date('2099-03-06') }];
    await expect(setup({ existing: stay }).service.create('t1', { ...NAP, napStartHour: 12 } as never)).resolves.toBeDefined();
    await expect(setup({ existing: stay }).service.create('t1', { ...NAP, napStartHour: 9 } as never)).rejects.toThrow(/pas libre/);
  });

  it('refuse un séjour dont une nuit est occupée par une sieste', async () => {
    const nap: Row[] = [{ checkInDate: new Date('2099-03-06'), checkOutDate: new Date('2099-03-07'), napStartHour: 16, napHours: 3 }];
    await expect(
      setup({ existing: nap }).service.create('t1', { roomId: 'room-1', checkInDate: '2099-03-06', checkOutDate: '2099-03-08' } as never),
    ).rejects.toThrow(/sieste déjà réservée/);
  });

  it('refuse les siestes pour une salle de fêtes', async () => {
    await expect(setup({ type: 'EVENT_HALL' }).service.create('t1', NAP as never)).rejects.toThrow(/siestes/);
  });
});

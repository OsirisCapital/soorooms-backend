import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import type { PaymentsService } from '../payments/payments.service.js';
import { BookingsService } from './bookings.service.js';

const DTO = { roomId: 'room-1', checkInDate: '2099-01-10', checkOutDate: '2099-01-12', proposedPrice: 28000 } as never;
const block = (start: string, end: string, units: number | null = null) => ({ startDate: new Date(start), endDate: new Date(end), units });

function setup(unitCount: number, blocks: unknown[], stays: unknown[] = []) {
  const tx = { booking: { create: vi.fn().mockResolvedValue({ id: 'b1' }) }, priceOffer: { create: vi.fn() } };
  const prisma = {
    roomBlock: { findMany: vi.fn().mockResolvedValue(blocks) },
    room: { findUnique: vi.fn().mockResolvedValue({ id: 'room-1', basePrice: 15000, unitCount, property: { status: 'ACTIVE', title: 'Villa', collaborators: [] } }) },
    booking: {
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

describe('BookingsService — dates fermées par l’hôte', () => {
  it('refuse un séjour qui chevauche des dates fermées', async () => {
    const { service, tx } = setup(1, [block('2099-01-11', '2099-01-15')]);
    await expect(service.create('t1', DTO)).rejects.toThrow(/plus disponibles/);
    expect(tx.booking.create).not.toHaveBeenCalled();
  });

  it('accepte une arrivée le jour où le blocage prend fin (comme un départ)', async () => {
    const { service, tx } = setup(1, [block('2099-01-05', '2099-01-10')]);
    await service.create('t1', DTO);
    expect(tx.booking.create).toHaveBeenCalled();
  });

  it('ne ferme qu’une partie des unités : il en reste pour les voyageurs', async () => {
    const { service, tx } = setup(3, [block('2099-01-09', '2099-01-13', 2)]);
    await service.create('t1', DTO);
    expect(tx.booking.create).toHaveBeenCalled();
  });

  it('refuse quand fermetures et réservations occupent toutes les unités', async () => {
    const stay = { checkInDate: new Date('2099-01-09'), checkOutDate: new Date('2099-01-13') };
    const { service } = setup(3, [block('2099-01-09', '2099-01-13', 2)], [stay]);
    await expect(service.create('t1', DTO)).rejects.toThrow(/plus disponibles/);
  });
});

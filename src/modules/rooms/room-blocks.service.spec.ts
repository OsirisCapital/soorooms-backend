import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { RoomBlocksService } from './room-blocks.service.js';

function make(opts: { unitCount?: number; stays?: unknown[]; naps?: unknown[]; blocks?: unknown[] } = {}) {
  const create = vi.fn().mockImplementation(async ({ data }: { data: { startDate: Date; endDate: Date; units: number | null; reason: string | null } }) => ({ id: 'k1', ...data }));
  const findManyBooking = vi.fn().mockImplementation(async (a: { where: { napStartHour?: unknown } }) => (a.where.napStartHour === null ? (opts.stays ?? []) : (opts.naps ?? [])));
  const prisma = {
    room: { findFirst: vi.fn().mockResolvedValue({ id: 'r1', name: 'Standard', unitCount: opts.unitCount ?? 1 }) },
    booking: { findMany: findManyBooking },
    roomBlock: { findMany: vi.fn().mockResolvedValue(opts.blocks ?? []), create, deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  return { service: new RoomBlocksService(prisma as unknown as PrismaService), prisma, create };
}

describe('RoomBlocksService.create', () => {
  it('ferme les dates : la fin saisie est le dernier jour fermé, la reprise est le lendemain', async () => {
    const { service, create } = make();
    const res = await service.create('p1', 'r1', 'u1', { startDate: '2099-03-10', endDate: '2099-03-12', reason: 'Travaux' });
    expect(create.mock.calls[0][0].data.endDate.toISOString().slice(0, 10)).toBe('2099-03-13');
    expect(res).toMatchObject({ startDate: '2099-03-10', endDate: '2099-03-12', reason: 'Travaux' });
  });

  it('refuse de fermer des dates déjà réservées', async () => {
    const stay = { checkInDate: new Date('2099-03-11'), checkOutDate: new Date('2099-03-13'), units: 1 };
    const { service, create } = make({ stays: [stay] });
    await expect(service.create('p1', 'r1', 'u1', { startDate: '2099-03-10', endDate: '2099-03-12' })).rejects.toThrow(/réservations existent/);
    expect(create).not.toHaveBeenCalled();
  });

  it('refuse de fermer le jour d’une sieste réservée', async () => {
    const { service } = make({ naps: [{ checkInDate: new Date('2099-03-11'), units: 1 }] });
    await expect(service.create('p1', 'r1', 'u1', { startDate: '2099-03-10', endDate: '2099-03-12' })).rejects.toThrow(/réservations existent/);
  });

  it('autorise une fermeture partielle quand il reste des unités', async () => {
    const stay = { checkInDate: new Date('2099-03-11'), checkOutDate: new Date('2099-03-13'), units: 1 };
    const { service, create } = make({ unitCount: 3, stays: [stay] });
    await service.create('p1', 'r1', 'u1', { startDate: '2099-03-10', endDate: '2099-03-12', units: 2 });
    expect(create).toHaveBeenCalled();
    await expect(make({ unitCount: 3, stays: [stay] }).service.create('p1', 'r1', 'u1', { startDate: '2099-03-10', endDate: '2099-03-12', units: 3 })).rejects.toThrow(/réservations existent/);
  });

  it('refuse un double blocage des mêmes unités', async () => {
    const { service } = make({ blocks: [{ startDate: new Date('2099-03-11'), endDate: new Date('2099-03-14'), units: null }] });
    await expect(service.create('p1', 'r1', 'u1', { startDate: '2099-03-10', endDate: '2099-03-12' })).rejects.toThrow(/déjà fermées/);
  });

  it('refuse les dates passées, inversées, trop longues ou plus d’unités que le type', async () => {
    const { service } = make({ unitCount: 2 });
    await expect(service.create('p1', 'r1', 'u1', { startDate: '2020-01-01', endDate: '2020-01-03' })).rejects.toThrow(/passées/);
    await expect(service.create('p1', 'r1', 'u1', { startDate: '2099-03-12', endDate: '2099-03-10' })).rejects.toThrow(/précéder/);
    await expect(service.create('p1', 'r1', 'u1', { startDate: '2099-01-01', endDate: '2100-06-01' })).rejects.toThrow(/un an/);
    await expect(service.create('p1', 'r1', 'u1', { startDate: '2099-03-10', endDate: '2099-03-12', units: 5 })).rejects.toThrow(/2 unités/);
    await expect(service.create('p1', 'r1', 'u1', { startDate: '2099-02-30', endDate: '2099-03-12' })).rejects.toThrow(/invalides/);
  });
});

describe('RoomBlocksService.remove / list', () => {
  it('ne supprime qu’un blocage de CETTE chambre', async () => {
    const { service, prisma } = make();
    await service.remove('p1', 'r1', 'k1');
    expect(prisma.roomBlock.deleteMany).toHaveBeenCalledWith({ where: { id: 'k1', roomId: 'r1' } });
    prisma.roomBlock.deleteMany.mockResolvedValue({ count: 0 });
    await expect(service.remove('p1', 'r1', 'x')).rejects.toThrow(/introuvable/);
  });

  it('liste les blocages avec le dernier jour fermé inclus', async () => {
    const { service } = make({ blocks: [{ id: 'k1', startDate: new Date('2099-03-10'), endDate: new Date('2099-03-13'), units: null, reason: null }] });
    expect(await service.list('p1', 'r1')).toEqual([{ id: 'k1', startDate: '2099-03-10', endDate: '2099-03-12', units: null, reason: null }]);
  });
});

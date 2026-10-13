import { Logger, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import { MonitoringService } from './monitoring.service.js';

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

function make(existing: { id: string; resolvedAt: Date | null; count: number } | null = null) {
  const errorEvent = {
    findUnique: vi.fn().mockResolvedValue(existing),
    create: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
  };
  const notifyStaff = vi.fn().mockResolvedValue(undefined);
  const prisma = { errorEvent, $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]) };
  const service = new MonitoringService(prisma as unknown as PrismaService, { notifyStaff } as unknown as NotificationsService);
  return { service, errorEvent, notifyStaff, prisma };
}

const input = { method: 'POST', path: '/bookings/3f2a9c1e-1111-4222-8333-444455556666/cancel', status: 500, error: new Error('boom'), userId: 'u1' };

describe('MonitoringService.report', () => {
  it("crée la ligne et alerte l'équipe à la première occurrence", async () => {
    const { service, errorEvent, notifyStaff } = make();
    await service.report(input);
    expect(errorEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ method: 'POST', path: '/bookings/:id/cancel', message: 'boom', lastUserId: 'u1' }) });
    expect(notifyStaff).toHaveBeenCalledWith('audit.view', 'ERROR_ALERT_STAFF', { message: 'boom', path: '/bookings/:id/cancel', count: 1, reopened: false });
  });

  it("compte les répétitions sans alerter à chaque fois", async () => {
    const { service, errorEvent, notifyStaff } = make({ id: 'e1', resolvedAt: null, count: 1 });
    await service.report(input);
    expect(errorEvent.update).toHaveBeenCalledWith({ where: { id: 'e1' }, data: expect.objectContaining({ count: { increment: 1 }, resolvedAt: null }) });
    expect(notifyStaff).not.toHaveBeenCalled();
  });

  it('alerte quand une erreur marquée résolue revient', async () => {
    const { service, notifyStaff } = make({ id: 'e1', resolvedAt: new Date(), count: 3 });
    await service.report(input);
    expect(notifyStaff).toHaveBeenCalledWith('audit.view', 'ERROR_ALERT_STAFF', expect.objectContaining({ reopened: true, count: 4 }));
  });

  it('ne lève jamais d’erreur, même si la base est en panne', async () => {
    const { service, errorEvent } = make();
    errorEvent.findUnique.mockRejectedValue(new Error('db down'));
    await expect(service.report(input)).resolves.toBeUndefined();
  });
});

describe('MonitoringService.resolve / list / santé', () => {
  it('marque une erreur résolue, et signale une erreur inconnue', async () => {
    const { service, errorEvent } = make();
    expect(await service.resolve('e1')).toEqual({ resolved: true });
    errorEvent.updateMany.mockResolvedValue({ count: 0 });
    errorEvent.findUnique.mockResolvedValue(null);
    await expect(service.resolve('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('liste seulement les erreurs ouvertes par défaut', async () => {
    const { service, errorEvent } = make();
    await service.list(false);
    expect(errorEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { resolvedAt: null } }));
    await service.list(true);
    expect(errorEvent.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: {} }));
  });

  it('dit si la base répond', async () => {
    const { service, prisma } = make();
    expect(await service.databaseReachable()).toBe(true);
    prisma.$queryRaw.mockRejectedValue(new Error('down'));
    expect(await service.databaseReachable()).toBe(false);
  });
});

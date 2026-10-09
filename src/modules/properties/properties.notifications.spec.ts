import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import { PropertiesService } from './properties.service.js';

function make(status: 'PENDING_KYC' | 'ACTIVE' | 'SUSPENDED' = 'PENDING_KYC') {
  const prisma = {
    user: { findUnique: vi.fn().mockResolvedValue({ id: 'host-1', emailVerifiedAt: new Date(), kycStatus: 'APPROVED' }) },
    property: {
      findUnique: vi.fn().mockResolvedValue({ id: 'p1', title: 'Villa Kribi', status, _count: { rooms: 2 } }),
      update: vi.fn().mockResolvedValue({ id: 'p1', status: 'ACTIVE' }),
    },
  };
  const notifications = { notify: vi.fn().mockResolvedValue(true) };
  return { prisma, notifications, service: new PropertiesService(prisma as unknown as PrismaService, notifications as unknown as NotificationsService) };
}

describe('PropertiesService.publish — notification', () => {
  it("prévient le gestionnaire quand son logement devient visible", async () => {
    const { service, notifications } = make();
    await service.publish('p1', 'host-1');
    expect(notifications.notify).toHaveBeenCalledWith('host-1', 'PROPERTY_PUBLISHED', { propertyId: 'p1', propertyTitle: 'Villa Kribi' });
  });

  it("ne renotifie pas si le logement était déjà publié", async () => {
    const { service, notifications } = make('ACTIVE');
    await service.publish('p1', 'host-1');
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it("ne notifie rien quand la publication est refusée (logement suspendu)", async () => {
    const { service, notifications } = make('SUSPENDED');
    await expect(service.publish('p1', 'host-1')).rejects.toThrow();
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it("fonctionne sans service de notifications (ancien montage)", async () => {
    const { prisma } = make();
    const service = new PropertiesService(prisma as unknown as PrismaService);
    await expect(service.publish('p1', 'host-1')).resolves.toBeTruthy();
  });
});

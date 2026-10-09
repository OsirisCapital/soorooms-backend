import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { NotificationEmailService } from './notification-email.service.js';
import { NotificationsService } from './notifications.service.js';

function make(overrides: Record<string, unknown> = {}) {
  const notification = {
    create: vi.fn().mockResolvedValue({}),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(3),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  const user = { findMany: vi.fn().mockResolvedValue([]) };
  const emails = { sendFor: vi.fn().mockResolvedValue(undefined) };
  const prisma = { notification, user, ...overrides };
  return { service: new NotificationsService(prisma as unknown as PrismaService, emails as unknown as NotificationEmailService), notification, user, emails };
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

describe('NotificationsService.notify', () => {
  it('écrit le titre, le texte et le lien du catalogue', async () => {
    const { service, notification } = make();
    expect(await service.notify('u1', 'KYC_APPROVED', {})).toBe(true);
    expect(notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'u1', type: 'KYC_APPROVED', title: expect.any(String), body: expect.any(String), linkUrl: '/hote' }),
    });
  });

  it("n'échoue JAMAIS : une erreur d'écriture ne doit pas faire échouer le paiement ou la réservation", async () => {
    const { service, notification } = make();
    notification.create.mockRejectedValue(new Error('base indisponible'));
    await expect(service.notify('u1', 'KYC_APPROVED', {})).resolves.toBe(false);
  });
});

describe('NotificationsService — e-mails', () => {
  it("demande l'e-mail avec le même texte que la cloche", async () => {
    const { service, emails } = make();
    await service.notify('u1', 'KYC_APPROVED', {});
    expect(emails.sendFor).toHaveBeenCalledWith(['u1'], 'KYC_APPROVED', { title: expect.any(String), body: expect.any(String), linkUrl: '/hote' });
  });

  it("un e-mail qui échoue ne fait pas échouer la notification, ni l'action qui l'a déclenchée", async () => {
    const { service, emails } = make();
    emails.sendFor.mockRejectedValue(new Error('Brevo en panne'));
    await expect(service.notify('u1', 'KYC_APPROVED', {})).resolves.toBe(true);
  });

  it("n'envoie aucun e-mail si la notification n'a pas pu être écrite", async () => {
    const { service, notification, emails } = make();
    notification.create.mockRejectedValue(new Error('x'));
    await service.notify('u1', 'KYC_APPROVED', {});
    expect(emails.sendFor).not.toHaveBeenCalled();
  });

  it('notifyMany envoie une seule fois par personne', async () => {
    const { service, emails } = make();
    await service.notifyMany(['a', 'b', 'a'], 'MESSAGE_RECEIVED', { fromName: 'Z' });
    expect(emails.sendFor).toHaveBeenCalledWith(['a', 'b'], 'MESSAGE_RECEIVED', expect.any(Object));
  });
});

describe('NotificationsService — préférences', () => {
  it("lit l'interrupteur et dit si l'adresse est vérifiée", async () => {
    const { service, user } = make();
    Object.assign(user, { findUnique: vi.fn().mockResolvedValue({ emailNotifications: false, email: 'a@b.c', emailVerifiedAt: new Date() }) });
    expect(await service.getPreferences('u1')).toEqual({ emailEnabled: false, emailVerified: true });
    Object.assign(user, { findUnique: vi.fn().mockResolvedValue({ emailNotifications: true, email: 'a@b.c', emailVerifiedAt: null }) });
    expect(await service.getPreferences('u1')).toEqual({ emailEnabled: true, emailVerified: false });
  });

  it("ne modifie que le compte de la personne connectée", async () => {
    const { service, user } = make();
    const update = vi.fn().mockResolvedValue({});
    Object.assign(user, { update, findUnique: vi.fn().mockResolvedValue({ emailNotifications: false, email: null, emailVerifiedAt: null }) });
    await service.setEmailEnabled('u1', false);
    expect(update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { emailNotifications: false } });
  });
});

describe('NotificationsService.notifyMany', () => {
  it('écrit une seule notification par personne, et rien si la liste est vide', async () => {
    const { service, notification } = make();
    await service.notifyMany(['a', 'b', 'a'], 'MESSAGE_RECEIVED', { fromName: 'Z' });
    expect(notification.createMany.mock.calls[0][0].data.map((d: { userId: string }) => d.userId)).toEqual(['a', 'b']);
    await service.notifyMany([], 'MESSAGE_RECEIVED', { fromName: 'Z' });
    expect(notification.createMany).toHaveBeenCalledTimes(1);
  });

  it('ne lève pas d\'erreur si l\'écriture échoue', async () => {
    const { service, notification } = make();
    notification.createMany.mockRejectedValue(new Error('x'));
    await expect(service.notifyMany(['a'], 'MESSAGE_RECEIVED', { fromName: 'Z' })).resolves.toBeUndefined();
  });
});

describe('NotificationsService.notifyStaff', () => {
  const admins = [
    { id: 'super', role: 'ADMIN', staffRole: null, staffPermissions: [] }, // ancien admin = super administrateur
    { id: 'kyc', role: 'ADMIN', staffRole: 'KYC_REVIEWER', staffPermissions: [] },
    { id: 'support', role: 'ADMIN', staffRole: 'SUPPORT', staffPermissions: [] },
    { id: 'finance', role: 'ADMIN', staffRole: 'FINANCE', staffPermissions: [] },
  ];

  it("n'alerte que les membres qui ont l'accès voulu", async () => {
    const { service, notification, user } = make();
    user.findMany.mockResolvedValue(admins);
    await service.notifyStaff('kyc.review', 'KYC_SUBMITTED', { fullName: 'M' });
    expect(notification.createMany.mock.calls[0][0].data.map((d: { userId: string }) => d.userId)).toEqual(['super', 'kyc']);
  });

  it("n'alerte pas la personne à l'origine de l'événement", async () => {
    const { service, notification, user } = make();
    user.findMany.mockResolvedValue(admins);
    await service.notifyStaff('kyc.review', 'KYC_SUBMITTED', { fullName: 'M' }, 'kyc');
    expect(notification.createMany.mock.calls[0][0].data.map((d: { userId: string }) => d.userId)).toEqual(['super']);
  });

  it('les litiges vont à la finance, pas au support', async () => {
    const { service, notification, user } = make();
    user.findMany.mockResolvedValue(admins);
    await service.notifyStaff('disputes.view', 'DISPUTE_OPENED_STAFF', { bookingId: 'b' });
    expect(notification.createMany.mock.calls[0][0].data.map((d: { userId: string }) => d.userId)).toEqual(['super', 'finance']);
  });

  it('ne lève pas d\'erreur si la recherche de l\'équipe échoue', async () => {
    const { service, user } = make();
    user.findMany.mockRejectedValue(new Error('x'));
    await expect(service.notifyStaff('kyc.review', 'KYC_SUBMITTED', { fullName: 'M' })).resolves.toBeUndefined();
  });
});

describe('NotificationsService.listMine / markRead', () => {
  it('ne lit que les notifications de la personne, borne la page et signale s\'il y en a d\'autres', async () => {
    const { service, notification } = make();
    notification.findMany.mockResolvedValue(Array.from({ length: 31 }, (_, i) => ({ id: String(i) })));
    const result = await service.listMine('u1', { limit: 30, unreadOnly: true });
    expect(notification.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: 'u1', readAt: null }), take: 31 }));
    expect(result.items).toHaveLength(30);
    expect(result.hasMore).toBe(true);

    await service.listMine('u1', { limit: 100000 });
    expect(notification.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ take: 51 }));
    await service.listMine('u1', { limit: -4 });
    expect(notification.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ take: 2 }));
  });

  it('ignore une date « before » invalide', async () => {
    const { service, notification } = make();
    await service.listMine('u1', { before: 'pas-une-date' });
    expect(notification.findMany.mock.calls[0][0].where.createdAt).toBeUndefined();
  });

  it("marquer comme lue ne touche que SES notifications (l'identifiant seul ne suffit pas)", async () => {
    const { service, notification } = make();
    await service.markRead('u1', 'n42');
    expect(notification.updateMany).toHaveBeenCalledWith({ where: { id: 'n42', userId: 'u1', readAt: null }, data: { readAt: expect.any(Date) } });
  });

  it('« tout lire » est limité à la personne connectée', async () => {
    const { service, notification } = make();
    await service.markAllRead('u1');
    expect(notification.updateMany).toHaveBeenCalledWith({ where: { userId: 'u1', readAt: null }, data: { readAt: expect.any(Date) } });
  });
});

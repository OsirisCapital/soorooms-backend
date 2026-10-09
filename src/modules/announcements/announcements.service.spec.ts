import { ConflictException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';
import { PERMISSIONS_KEY } from '../../common/decorators/permissions.decorator.js';
import { ROLES_KEY } from '../../common/decorators/roles.decorator.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import { AnnouncementsAdminController } from './announcements.controller.js';
import { AnnouncementsService } from './announcements.service.js';
import { AnnouncementDto } from './dto/announcements.dto.js';

const ROW = { id: 'an1', title: 'Nouveauté', body: 'La messagerie est là.', href: '/messages', audience: 'ALL', status: 'PUBLISHED' };

function make(over: { claimed?: number; exists?: boolean; users?: number } = {}) {
  const users = Array.from({ length: over.users ?? 3 }, (_, i) => ({ id: `u${i}` }));
  const tx = {
    announcement: { updateMany: vi.fn().mockResolvedValue({ count: over.claimed ?? 1 }), findUniqueOrThrow: vi.fn().mockResolvedValue(ROW) },
    auditLog: { create: vi.fn() },
  };
  const prisma = {
    announcement: {
      updateMany: vi.fn().mockResolvedValue({ count: over.claimed ?? 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: over.claimed ?? 1 }),
      findUnique: vi.fn().mockResolvedValue(over.exists === false ? null : { id: 'an1' }),
      update: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockResolvedValue({}),
    },
    user: { findMany: vi.fn().mockResolvedValue(users) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const notifications = { notifyMany: vi.fn().mockResolvedValue(undefined) };
  return { service: new AnnouncementsService(prisma as unknown as PrismaService, notifications as unknown as NotificationsService), prisma, tx, notifications };
}

describe('AnnouncementsService.publish', () => {
  it('publie, journalise dans la même transaction, puis notifie le public visé', async () => {
    const { service, tx, notifications, prisma } = make();
    const out = await service.publish('a1', 'an1');
    // Le « verrou » : seul un brouillon peut passer à publié, et un seul appel gagne.
    expect(tx.announcement.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'an1', status: 'DRAFT' } }));
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ actorId: 'a1', action: 'announcement.publish', targetId: 'an1' }) });
    expect(notifications.notifyMany).toHaveBeenCalledWith(['u0', 'u1', 'u2'], 'ANNOUNCEMENT', { title: 'Nouveauté', body: 'La messagerie est là.', href: '/messages' });
    expect(prisma.announcement.update).toHaveBeenCalledWith({ where: { id: 'an1' }, data: { recipientCount: 3 } });
    expect(out.recipientCount).toBe(3);
  });

  it('une annonce déjà publiée ne repart pas : aucune notification en double', async () => {
    const { service, notifications } = make({ claimed: 0 });
    await expect(service.publish('a1', 'an1')).rejects.toBeInstanceOf(ConflictException);
    expect(notifications.notifyMany).not.toHaveBeenCalled();
  });

  it('annonce inconnue : 404', async () => {
    const { service } = make({ claimed: 0, exists: false });
    await expect(service.publish('a1', 'x')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('cible le bon public', async () => {
    for (const [audience, roles] of [['TRAVELERS', ['TRAVELER']], ['HOSTS', ['HOST']]] as const) {
      const { service, tx, prisma } = make();
      tx.announcement.findUniqueOrThrow.mockResolvedValue({ ...ROW, audience });
      await service.publish('a1', 'an1');
      expect(prisma.user.findMany).toHaveBeenCalledWith({ where: { role: { in: roles } }, select: { id: true } });
    }
    const all = make();
    await all.service.publish('a1', 'an1');
    expect(all.prisma.user.findMany).toHaveBeenCalledWith({ where: {}, select: { id: true } });
  });

  it('envoie par paquets de 500', async () => {
    const { service, notifications } = make({ users: 1200 });
    await service.publish('a1', 'an1');
    expect(notifications.notifyMany.mock.calls.map((c) => c[0].length)).toEqual([500, 500, 200]);
  });
});

describe('AnnouncementsService — brouillons', () => {
  it('ne modifie et ne supprime que les brouillons', async () => {
    const { service, prisma } = make({ claimed: 0 });
    await expect(service.update('an1', { title: 'Titre', body: 'Corps du message', audience: 'ALL' })).rejects.toBeInstanceOf(ConflictException);
    await expect(service.remove('an1')).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.announcement.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'an1', status: 'DRAFT' } }));
    expect(prisma.announcement.deleteMany).toHaveBeenCalledWith({ where: { id: 'an1', status: 'DRAFT' } });
  });
});

describe('AnnouncementDto', () => {
  const check = (v: object) => validate(plainToInstance(AnnouncementDto, v));
  const base = { title: 'Nouveauté', body: 'Un message clair.', audience: 'ALL' };
  it('accepte un lien interne ou aucun lien', async () => {
    expect(await check({ ...base, href: '/explorer' })).toHaveLength(0);
    expect(await check({ ...base, href: '' })).toHaveLength(0);
    expect(await check(base)).toHaveLength(0);
  });
  it('refuse un lien extérieur ou piégé', async () => {
    for (const href of ['https://evil.example', '//evil.example', 'javascript:alert(1)', '/a\\b', '/a b']) {
      expect((await check({ ...base, href })).length, href).toBeGreaterThan(0);
    }
  });
  it('refuse un public inconnu et un message trop long', async () => {
    expect((await check({ ...base, audience: 'STAFF' })).length).toBeGreaterThan(0);
    expect((await check({ ...base, body: 'x'.repeat(301) })).length).toBeGreaterThan(0);
  });
});

describe('Contrôleur — qui a le droit', () => {
  it('exige ADMIN et « announcements.manage »', () => {
    const reflector = new Reflector();
    expect(reflector.get(ROLES_KEY, AnnouncementsAdminController)).toEqual(['ADMIN']);
    expect(reflector.get(PERMISSIONS_KEY, AnnouncementsAdminController)).toEqual(['announcements.manage']);
  });
});

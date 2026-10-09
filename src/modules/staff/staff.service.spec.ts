import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';
import { PERMISSIONS_KEY, STAFF_ONLY_KEY } from '../../common/decorators/permissions.decorator.js';
import { ROLES_KEY } from '../../common/decorators/roles.decorator.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import { AddStaffDto, CreateTaskDto, UpdateStaffDto } from './dto/staff.dto.js';
import { StaffController, TasksController } from './staff.controller.js';
import { lookupFor, StaffService } from './staff.service.js';

const person = (id: string, staffRole: string | null, extra: string[] = [], role = 'ADMIN') => ({
  id, fullName: `Nom ${id}`, email: `${id}@ex.cm`, phone: '+237600000000', role, staffRole, staffPermissions: extra, emailVerifiedAt: new Date(), hostProfile: null,
});
const SUPER = person('super', 'SUPER_ADMIN');
const LEGACY_SUPER = person('legacy', null); // ADMIN sans niveau = super administrateur
const SUPPORT_MGR = person('mgr', 'SUPPORT', ['staff.manage']); // peut gérer l'équipe sans être super administrateur

function make(users: Record<string, ReturnType<typeof person> | undefined>, over: { otherSupers?: number; lookup?: ReturnType<typeof person> | null } = {}) {
  const tx = {
    user: { update: vi.fn().mockImplementation(async ({ where, data }) => ({ ...(users[where.id] ?? person(where.id, null)), ...data })) },
    staffTask: { updateMany: vi.fn() },
    supportTicket: { updateMany: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  const prisma = {
    user: {
      findUnique: vi.fn().mockImplementation(async ({ where }) => users[where.id] ?? null),
      findFirst: vi.fn().mockResolvedValue(over.lookup ?? null),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(over.otherSupers ?? 1),
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const notifications = { notify: vi.fn().mockResolvedValue(true) };
  return { service: new StaffService(prisma as unknown as PrismaService, notifications as unknown as NotificationsService), prisma, tx, notifications };
}

describe('lookupFor', () => {
  it('reconnaît un e-mail (en minuscules) ou un téléphone (sans espaces ni tirets)', () => {
    expect(lookupFor('  Marie@Ex.CM ')).toEqual({ email: 'marie@ex.cm' });
    expect(lookupFor('+237 6 77-00 00 00')).toEqual({ phone: '+237677000000' });
  });
});

describe('StaffService.add', () => {
  const dto = { identifier: 'new@ex.cm', staffRole: 'SUPPORT' as const, permissions: [] as string[] };

  it('nomme un membre, journalise dans la même transaction et le prévient', async () => {
    const target = person('t1', null, [], 'TRAVELER');
    const { service, tx, notifications } = make({ super: SUPER }, { lookup: target });
    await service.add('super', dto);
    expect(tx.user.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 't1' }, data: { role: 'ADMIN', staffRole: 'SUPPORT', staffPermissions: [] } }));
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ actorId: 'super', action: 'staff.add', targetId: 't1' }) });
    expect(notifications.notify).toHaveBeenCalledWith('t1', 'STAFF_ACCESS_CHANGED', { roleLabel: 'Support' });
  });

  it('refuse un compte à e-mail non vérifié (risque de récupération d’accès)', async () => {
    const { service, tx } = make({ super: SUPER }, { lookup: { ...person('t1', null, [], 'TRAVELER'), emailVerifiedAt: null as unknown as Date } });
    await expect(service.add('super', dto)).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('refuse : compte introuvable, déjà membre, ou soi-même', async () => {
    await expect(make({ super: SUPER }, { lookup: null }).service.add('super', dto)).rejects.toBeInstanceOf(NotFoundException);
    await expect(make({ super: SUPER }, { lookup: person('t1', 'SUPPORT') }).service.add('super', dto)).rejects.toBeInstanceOf(ConflictException);
    await expect(make({ super: SUPER }, { lookup: SUPER }).service.add('super', dto)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('un non-super ne nomme pas de super administrateur et ne donne pas un accès qu’il n’a pas', async () => {
    const lookup = person('t1', null, [], 'TRAVELER');
    const a = make({ mgr: SUPPORT_MGR }, { lookup });
    await expect(a.service.add('mgr', { ...dto, staffRole: 'SUPER_ADMIN' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(a.service.add('mgr', { ...dto, staffRole: 'FINANCE' })).rejects.toBeInstanceOf(ForbiddenException); // ses accès ne couvrent pas la finance
    await expect(a.service.add('mgr', { ...dto, permissions: ['kyc.review'] })).rejects.toBeInstanceOf(ForbiddenException);
    expect(a.tx.user.update).not.toHaveBeenCalled();
    await expect(a.service.add('mgr', { ...dto, permissions: ['users.view'] })).resolves.toBeDefined(); // un accès qu'il a
  });

  it('un compte qui n’est plus ADMIN ne peut rien faire', async () => {
    const { service } = make({ gone: person('gone', 'SUPPORT', ['staff.manage'], 'TRAVELER') });
    await expect(service.add('gone', dto)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('StaffService.update', () => {
  const dto = { staffRole: 'FINANCE' as const, permissions: [] as string[] };

  it('change le niveau et les accès, journalise avant/après', async () => {
    const { service, tx } = make({ super: SUPER, t1: person('t1', 'SUPPORT') });
    await service.update('super', 't1', dto);
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'staff.update', meta: { before: { staffRole: 'SUPPORT', permissions: [] }, after: { staffRole: 'FINANCE', permissions: [] } } }) });
  });

  it('on ne modifie pas son propre compte', async () => {
    const { service, tx } = make({ super: SUPER });
    await expect(service.update('super', 'super', dto)).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('seul un super administrateur modifie un super administrateur', async () => {
    const { service } = make({ mgr: SUPPORT_MGR, s2: person('s2', 'SUPER_ADMIN') });
    await expect(service.update('mgr', 's2', { staffRole: 'SUPPORT', permissions: [] })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('on ne rétrograde pas le dernier super administrateur', async () => {
    const last = make({ super: SUPER, s2: person('s2', 'SUPER_ADMIN') }, { otherSupers: 0 });
    await expect(last.service.update('super', 's2', dto)).rejects.toBeInstanceOf(ConflictException);
    expect(last.tx.user.update).not.toHaveBeenCalled();
    const ok = make({ super: SUPER, s2: person('s2', 'SUPER_ADMIN') }, { otherSupers: 1 });
    await expect(ok.service.update('super', 's2', dto)).resolves.toBeDefined();
  });

  it('un ADMIN sans niveau (compte antérieur) compte comme super administrateur', async () => {
    const { service, prisma } = make({ super: SUPER, old: LEGACY_SUPER }, { otherSupers: 0 });
    await expect(service.update('super', 'old', dto)).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.user.count).toHaveBeenCalledWith({ where: { role: 'ADMIN', id: { not: 'old' }, OR: [{ staffRole: null }, { staffRole: 'SUPER_ADMIN' }] } });
  });

  it('membre introuvable ou non ADMIN : 404', async () => {
    await expect(make({ super: SUPER }).service.update('super', 'x', dto)).rejects.toBeInstanceOf(NotFoundException);
    await expect(make({ super: SUPER, v: person('v', null, [], 'TRAVELER') }).service.update('super', 'v', dto)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('StaffService.remove', () => {
  it('retire le rôle, libère tâches et demandes, journalise, prévient', async () => {
    const { service, tx, notifications } = make({ super: SUPER, t1: { ...person('t1', 'SUPPORT'), hostProfile: { userId: 't1' } } as never });
    await service.remove('super', 't1');
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 't1' }, data: { role: 'HOST', staffRole: null, staffPermissions: [] } });
    expect(tx.staffTask.updateMany).toHaveBeenCalledWith({ where: { assigneeId: 't1', status: { not: 'DONE' } }, data: { assigneeId: null } });
    expect(tx.supportTicket.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ assigneeId: 't1' }), data: { assigneeId: null } }));
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'staff.remove', targetId: 't1' }) });
    expect(notifications.notify).toHaveBeenCalledWith('t1', 'STAFF_ACCESS_CHANGED', { roleLabel: null });
  });

  it('redevient voyageur s’il n’avait pas de profil hôte', async () => {
    const { service, tx } = make({ super: SUPER, t1: person('t1', 'SUPPORT') });
    await service.remove('super', 't1');
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 't1' }, data: expect.objectContaining({ role: 'TRAVELER' }) });
  });

  it('refuse : soi-même, dernier super administrateur, super par un non-super', async () => {
    await expect(make({ super: SUPER }).service.remove('super', 'super')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(make({ super: SUPER, s2: person('s2', 'SUPER_ADMIN') }, { otherSupers: 0 }).service.remove('super', 's2')).rejects.toBeInstanceOf(ConflictException);
    await expect(make({ mgr: SUPPORT_MGR, s2: person('s2', 'SUPER_ADMIN') }).service.remove('mgr', 's2')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('DTO', () => {
  it('l’ajout n’accepte que des niveaux et des accès connus', async () => {
    const check = (v: object) => validate(plainToInstance(AddStaffDto, v));
    expect(await check({ identifier: 'a@b.cm', staffRole: 'SUPPORT', permissions: ['users.view'] })).toHaveLength(0);
    expect((await check({ identifier: 'a@b.cm', staffRole: 'ROOT', permissions: [] })).length).toBeGreaterThan(0);
    expect((await check({ identifier: 'a@b.cm', staffRole: 'SUPPORT', permissions: ['db.drop'] })).length).toBeGreaterThan(0);
    expect((await validate(plainToInstance(UpdateStaffDto, { staffRole: 'SUPPORT' }))).length).toBeGreaterThan(0);
  });

  it('une tâche : titre, date réelle, lien interne seulement', async () => {
    const check = (v: object) => validate(plainToInstance(CreateTaskDto, v));
    const base = { title: 'Relancer le support', assigneeId: '3f2b8c9e-1d4a-4b6c-8e7f-0a1b2c3d4e5f', priority: 'NORMAL' };
    expect(await check({ ...base, dueDate: '2026-10-20', href: '/admin/support' })).toHaveLength(0);
    expect(await check({ ...base, dueDate: '', href: '' })).toHaveLength(0);
    for (const bad of [{ dueDate: '2026-13-45' }, { dueDate: 'demain' }, { href: 'https://evil.example' }, { href: '//evil.example' }, { priority: 'URGENT' }, { assigneeId: 'abc' }, { title: 'ab' }]) {
      expect((await check({ ...base, ...bad })).length, JSON.stringify(bad)).toBeGreaterThan(0);
    }
  });
});

describe('Contrôleurs — qui a le droit', () => {
  const reflector = new Reflector();
  it('la gestion de l’équipe exige ADMIN et « staff.manage »', () => {
    expect(reflector.get(ROLES_KEY, StaffController)).toEqual(['ADMIN']);
    expect(reflector.get(PERMISSIONS_KEY, StaffController)).toEqual(['staff.manage']);
  });
  it('les tâches : accessibles à toute l’équipe, sauf créer / réassigner / supprimer', () => {
    expect(reflector.get(ROLES_KEY, TasksController)).toEqual(['ADMIN']);
    expect(reflector.get(STAFF_ONLY_KEY, TasksController)).toBe(true);
    const proto = TasksController.prototype;
    for (const route of [proto.create, proto.assign, proto.remove]) expect(reflector.get(PERMISSIONS_KEY, route)).toEqual(['staff.manage']);
    for (const route of [proto.list, proto.status, proto.openCount]) expect(reflector.get(PERMISSIONS_KEY, route)).toBeUndefined();
  });
});

import { ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import { TasksService } from './tasks.service.js';

const acct = (id: string, staffRole: string | null, role = 'ADMIN', extra: string[] = []) => ({ id, fullName: `Nom ${id}`, role, staffRole, staffPermissions: extra });
const MANAGER = acct('boss', 'SUPER_ADMIN');
const AGENT = acct('agent', 'SUPPORT');
const OTHER = acct('other', 'KYC_REVIEWER');
const TASK = { id: 't1', title: 'Relancer les dossiers', status: 'TODO', assigneeId: 'agent', createdById: 'boss', dueDate: new Date('2026-10-20T00:00:00Z') };
const ROW = { id: 't1', title: 'Relancer les dossiers', dueDate: new Date('2026-10-20T00:00:00Z'), status: 'DONE' };

function make(users: Record<string, ReturnType<typeof acct>>, task: Record<string, unknown> | null = TASK) {
  const tx = { staffTask: { create: vi.fn().mockResolvedValue(ROW), update: vi.fn().mockResolvedValue(ROW) }, auditLog: { create: vi.fn() } };
  const prisma = {
    user: { findUnique: vi.fn().mockImplementation(async ({ where }) => users[where.id] ?? null) },
    staffTask: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(task),
      update: vi.fn().mockResolvedValue(ROW),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      count: vi.fn().mockResolvedValue(2),
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const notifications = { notify: vi.fn().mockResolvedValue(true) };
  return { service: new TasksService(prisma as unknown as PrismaService, notifications as unknown as NotificationsService), prisma, tx, notifications };
}

const USERS = { boss: MANAGER, agent: AGENT, other: OTHER, trav: acct('trav', null, 'TRAVELER') };
const dto = { title: 'Relancer les dossiers', assigneeId: 'agent', priority: 'HIGH' as const, dueDate: '2026-10-20' };

describe('TasksService.list', () => {
  it('« mes tâches » ne renvoie que celles de la personne', async () => {
    const { service, prisma } = make(USERS);
    await service.list('agent', 'mine', 'open');
    expect(prisma.staffTask.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { assigneeId: 'agent', status: { in: ['TODO', 'IN_PROGRESS'] } } }));
  });

  it('« toutes » exige l’accès de gestion', async () => {
    const { service, prisma } = make(USERS);
    await expect(service.list('agent', 'all', 'open')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.staffTask.findMany).not.toHaveBeenCalled();
    await service.list('boss', 'all', 'all');
    expect(prisma.staffTask.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
  });

  it('un non-membre n’a rien', async () => {
    await expect(make(USERS).service.list('trav', 'mine', 'open')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('TasksService.create / reassign', () => {
  it('crée, journalise dans la même transaction et prévient la personne', async () => {
    const { service, tx, notifications } = make(USERS);
    await service.create('boss', dto);
    expect(tx.staffTask.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ assigneeId: 'agent', createdById: 'boss', priority: 'HIGH' }) }));
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'task.assign', meta: { assigneeId: 'agent' } }) });
    expect(notifications.notify).toHaveBeenCalledWith('agent', 'TASK_ASSIGNED', expect.objectContaining({ fromName: 'Nom boss', dueDate: '20/10/2026' }));
  });

  it('on ne se notifie pas soi-même', async () => {
    const { service, notifications } = make(USERS);
    await service.create('boss', { ...dto, assigneeId: 'boss' });
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('seul un responsable crée ; on ne confie qu’à un membre de l’équipe', async () => {
    const { service, tx } = make(USERS);
    await expect(service.create('agent', dto)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.create('boss', { ...dto, assigneeId: 'trav' })).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(tx.staffTask.create).not.toHaveBeenCalled();
  });

  it('réassigner : responsable seulement, personne cible membre, tâche existante', async () => {
    const a = make(USERS);
    await expect(a.service.reassign('agent', 't1', 'other')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(a.service.reassign('boss', 't1', 'trav')).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(make(USERS, null).service.reassign('boss', 't1', 'other')).rejects.toBeInstanceOf(NotFoundException);
    await a.service.reassign('boss', 't1', 'other');
    expect(a.notifications.notify).toHaveBeenCalledWith('other', 'TASK_ASSIGNED', expect.anything());
  });
});

describe('TasksService.setStatus', () => {
  it('le titulaire termine sa tâche : date de fin posée, créateur prévenu', async () => {
    const { service, prisma, notifications } = make(USERS);
    await service.setStatus('agent', 't1', 'DONE');
    expect(prisma.staffTask.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'DONE', completedAt: expect.any(Date) } }));
    expect(notifications.notify).toHaveBeenCalledWith('boss', 'TASK_DONE', { taskId: 't1', title: 'Relancer les dossiers', byName: 'Nom agent' });
  });

  it('rouvrir une tâche efface la date de fin, sans notification', async () => {
    const { service, prisma, notifications } = make(USERS, { ...TASK, status: 'DONE' });
    await service.setStatus('agent', 't1', 'IN_PROGRESS');
    expect(prisma.staffTask.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'IN_PROGRESS', completedAt: null } }));
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('une tâche déjà terminée ne renotifie pas', async () => {
    const { service, notifications } = make(USERS, { ...TASK, status: 'DONE' });
    await service.setStatus('agent', 't1', 'DONE');
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('un autre membre ne touche pas la tâche d’autrui ; un responsable si', async () => {
    const a = make(USERS);
    await expect(a.service.setStatus('other', 't1', 'DONE')).rejects.toBeInstanceOf(ForbiddenException);
    expect(a.prisma.staffTask.update).not.toHaveBeenCalled();
    await expect(a.service.setStatus('boss', 't1', 'DONE')).resolves.toBeDefined();
  });

  it('tâche inconnue : 404', async () => {
    await expect(make(USERS, null).service.setStatus('boss', 'x', 'DONE')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('TasksService.remove', () => {
  it('responsable seulement', async () => {
    const { service, prisma } = make(USERS);
    await expect(service.remove('agent', 't1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.staffTask.deleteMany).not.toHaveBeenCalled();
    await expect(service.remove('boss', 't1')).resolves.toEqual({ ok: true });
  });
});

/**
 * Tâches de l'équipe. Tout membre voit et fait avancer SES tâches ; seuls les accès « staff.manage »
 * en créent, les réassignent, les suppriment et voient celles des autres. Une tâche ne se confie
 * qu'à un membre de l'équipe. Le contrôle d'accès est refait ici, pas seulement dans le contrôleur.
 */
import { ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { permissionsFor } from '../admin/permissions.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type { CreateTaskDto } from './dto/staff.dto.js';

type Scope = 'mine' | 'all';
type Filter = 'open' | 'done' | 'all';

const SELECT = {
  id: true,
  title: true,
  details: true,
  priority: true,
  status: true,
  dueDate: true,
  href: true,
  completedAt: true,
  createdAt: true,
  assignee: { select: { id: true, fullName: true } },
  createdBy: { select: { id: true, fullName: true } },
} as const;

const dateOnly = (d: Date) => d.toISOString().slice(0, 10);
const frDate = (iso: string) => iso.split('-').reverse().join('/');

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  private async actor(actorId: string) {
    const account = await this.prisma.user.findUnique({ where: { id: actorId }, select: { id: true, fullName: true, role: true, staffRole: true, staffPermissions: true } });
    if (!account || account.role !== 'ADMIN') throw new ForbiddenException("Cet espace est réservé à l'équipe d'administration.");
    return { ...account, canManage: permissionsFor(account).includes('staff.manage') };
  }

  async list(actorId: string, scope: Scope, filter: Filter) {
    const actor = await this.actor(actorId);
    if (scope === 'all' && !actor.canManage) throw new ForbiddenException("Vous n'avez pas l'accès nécessaire pour voir les tâches de l'équipe.");
    const status = filter === 'open' ? { status: { in: ['TODO', 'IN_PROGRESS'] as Array<'TODO' | 'IN_PROGRESS'> } } : filter === 'done' ? { status: 'DONE' as const } : {};
    const tasks = await this.prisma.staffTask.findMany({
      where: { ...(scope === 'mine' ? { assigneeId: actorId } : {}), ...status },
      select: SELECT,
      orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
      take: 200,
    });
    return tasks.map((t) => ({ ...t, dueDate: t.dueDate ? dateOnly(t.dueDate) : null }));
  }

  /** Nombre de mes tâches ouvertes (pastille du tableau de bord). */
  async openCount(actorId: string) {
    await this.actor(actorId);
    return { count: await this.prisma.staffTask.count({ where: { assigneeId: actorId, status: { in: ['TODO', 'IN_PROGRESS'] } } }) };
  }

  private async assertStaffMember(userId: string) {
    const member = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true } });
    if (!member || member.role !== 'ADMIN') throw new UnprocessableEntityException("Une tâche ne peut être confiée qu'à un membre de l'équipe.");
  }

  async create(actorId: string, dto: CreateTaskDto) {
    const actor = await this.actor(actorId);
    if (!actor.canManage) throw new ForbiddenException("Vous n'avez pas l'accès nécessaire pour créer une tâche.");
    await this.assertStaffMember(dto.assigneeId);
    const task = await this.prisma.$transaction(async (tx) => {
      const created = await tx.staffTask.create({
        data: { title: dto.title, details: dto.details, priority: dto.priority, dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined, href: dto.href, assigneeId: dto.assigneeId, createdById: actorId },
        select: SELECT,
      });
      await tx.auditLog.create({ data: { actorId, action: 'task.assign', targetType: 'StaffTask', targetId: created.id, meta: { assigneeId: dto.assigneeId } } });
      return created;
    });
    if (dto.assigneeId !== actorId) await this.notifyAssigned(dto.assigneeId, task.id, task.title, actor.fullName, dto.dueDate);
    return { ...task, dueDate: task.dueDate ? dateOnly(task.dueDate) : null };
  }

  private notifyAssigned(assigneeId: string, taskId: string, title: string, fromName: string, dueDate?: string | null) {
    return this.notifications.notify(assigneeId, 'TASK_ASSIGNED', { taskId, title, fromName, dueDate: dueDate ? frDate(dueDate) : undefined });
  }

  async reassign(actorId: string, id: string, assigneeId: string) {
    const actor = await this.actor(actorId);
    if (!actor.canManage) throw new ForbiddenException("Vous n'avez pas l'accès nécessaire pour réassigner une tâche.");
    await this.assertStaffMember(assigneeId);
    const existing = await this.prisma.staffTask.findUnique({ where: { id }, select: { id: true, title: true, dueDate: true } });
    if (!existing) throw new NotFoundException('Tâche introuvable.');
    const task = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.staffTask.update({ where: { id }, data: { assigneeId }, select: SELECT });
      await tx.auditLog.create({ data: { actorId, action: 'task.assign', targetType: 'StaffTask', targetId: id, meta: { assigneeId } } });
      return updated;
    });
    if (assigneeId !== actorId) await this.notifyAssigned(assigneeId, id, existing.title, actor.fullName, existing.dueDate ? dateOnly(existing.dueDate) : null);
    return { ...task, dueDate: task.dueDate ? dateOnly(task.dueDate) : null };
  }

  /** Le titulaire de la tâche, ou un responsable d'équipe, la fait avancer. Personne d'autre. */
  async setStatus(actorId: string, id: string, status: 'TODO' | 'IN_PROGRESS' | 'DONE') {
    const actor = await this.actor(actorId);
    const existing = await this.prisma.staffTask.findUnique({ where: { id }, select: { id: true, title: true, status: true, assigneeId: true, createdById: true } });
    if (!existing) throw new NotFoundException('Tâche introuvable.');
    if (existing.assigneeId !== actorId && !actor.canManage) throw new ForbiddenException("Cette tâche ne vous est pas confiée.");
    const task = await this.prisma.staffTask.update({ where: { id }, data: { status, completedAt: status === 'DONE' ? new Date() : null }, select: SELECT });
    if (status === 'DONE' && existing.status !== 'DONE' && existing.createdById && existing.createdById !== actorId) {
      await this.notifications.notify(existing.createdById, 'TASK_DONE', { taskId: id, title: existing.title, byName: actor.fullName });
    }
    return { ...task, dueDate: task.dueDate ? dateOnly(task.dueDate) : null };
  }

  async remove(actorId: string, id: string) {
    const actor = await this.actor(actorId);
    if (!actor.canManage) throw new ForbiddenException("Vous n'avez pas l'accès nécessaire pour supprimer une tâche.");
    const { count } = await this.prisma.staffTask.deleteMany({ where: { id } });
    if (count === 0) throw new NotFoundException('Tâche introuvable.');
    return { ok: true };
  }
}

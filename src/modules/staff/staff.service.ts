/**
 * Gestion de l'équipe : qui en fait partie, à quel niveau, avec quels accès en plus.
 *
 * Règles de sécurité (toutes testées) :
 *  - réservé aux accès « staff.manage » ;
 *  - on ne modifie jamais son propre compte (pas d'auto-promotion, pas de blocage par accident) ;
 *  - on ne donne jamais plus que ce qu'on a : seul un super administrateur crée, modifie ou retire un
 *    super administrateur, et un accès ajouté doit faire partie des siens ;
 *  - il reste toujours au moins un super administrateur ;
 *  - on ne promeut qu'un compte dont l'e-mail est vérifié (sinon quelqu'un pourrait s'inscrire avec
 *    l'e-mail d'un autre pour récupérer ses accès) ;
 *  - chaque changement est écrit dans le journal d'audit, dans la même transaction.
 */
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { StaffRole } from '../../prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { effectiveStaffRole, permissionsFor, ROLE_PERMISSIONS, type Permission } from '../admin/permissions.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type { AddStaffDto, UpdateStaffDto } from './dto/staff.dto.js';
import { STAFF_ROLE_LABEL } from './staff.labels.js';

const MEMBER_SELECT = { id: true, fullName: true, email: true, phone: true, role: true, staffRole: true, staffPermissions: true } as const;
type Member = { id: string; fullName: string; email: string | null; phone: string; role: 'TRAVELER' | 'HOST' | 'ADMIN'; staffRole: StaffRole | null; staffPermissions: string[] };

const shape = (m: Member) => ({
  id: m.id,
  fullName: m.fullName,
  email: m.email,
  phone: m.phone,
  staffRole: effectiveStaffRole(m),
  extraPermissions: m.staffPermissions,
  permissions: permissionsFor(m),
});

/** Teste e-mail ou téléphone : « a@b.c » ou « +237 6 00-00 00 00 » donnent le bon critère de recherche. */
export function lookupFor(identifier: string): { email: string } | { phone: string } {
  const value = identifier.trim();
  if (value.includes('@')) return { email: value.toLowerCase() };
  return { phone: value.replace(/[\s().-]/g, '') };
}

@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async list() {
    const members = await this.prisma.user.findMany({ where: { role: 'ADMIN' }, select: MEMBER_SELECT, orderBy: { fullName: 'asc' }, take: 200 });
    return members.map(shape);
  }

  private async actorOf(actorId: string) {
    const actor = await this.prisma.user.findUnique({ where: { id: actorId }, select: MEMBER_SELECT });
    if (!actor || actor.role !== 'ADMIN') throw new ForbiddenException("Cet espace est réservé à l'équipe d'administration.");
    return actor;
  }

  /** Un accès qu'on n'a pas soi-même ne se donne pas ; le niveau super administrateur ne se confie que par un super administrateur. */
  private assertCanGrant(actor: Member, level: StaffRole, extras: string[]) {
    const mine = permissionsFor(actor);
    const isSuper = effectiveStaffRole(actor) === 'SUPER_ADMIN';
    if (level === 'SUPER_ADMIN' && !isSuper) throw new ForbiddenException('Seul un super administrateur peut nommer un super administrateur.');
    const wanted = new Set<string>([...ROLE_PERMISSIONS[level], ...extras]);
    for (const permission of wanted) {
      if (!mine.includes(permission as Permission)) throw new ForbiddenException("Vous ne pouvez pas accorder un accès que vous n'avez pas vous-même.");
    }
  }

  private async otherSuperAdmins(excludeId: string) {
    return this.prisma.user.count({ where: { role: 'ADMIN', id: { not: excludeId }, OR: [{ staffRole: null }, { staffRole: 'SUPER_ADMIN' }] } });
  }

  async add(actorId: string, dto: AddStaffDto) {
    const actor = await this.actorOf(actorId);
    this.assertCanGrant(actor, dto.staffRole, dto.permissions);
    const target = await this.prisma.user.findFirst({ where: lookupFor(dto.identifier), select: { ...MEMBER_SELECT, emailVerifiedAt: true } });
    if (!target) throw new NotFoundException('Aucun compte ne correspond. La personne doit d’abord créer son compte SòôRooms.');
    if (target.id === actorId) throw new ForbiddenException('Vous ne pouvez pas modifier votre propre compte.');
    if (target.role === 'ADMIN') throw new ConflictException('Cette personne fait déjà partie de l’équipe.');
    if (!target.emailVerifiedAt) throw new BadRequestException('Le compte doit avoir un e-mail vérifié avant de rejoindre l’équipe.');

    const updated = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.update({ where: { id: target.id }, data: { role: 'ADMIN', staffRole: dto.staffRole, staffPermissions: dto.permissions }, select: MEMBER_SELECT });
      await tx.auditLog.create({
        data: { actorId, action: 'staff.add', targetType: 'User', targetId: target.id, meta: { staffRole: dto.staffRole, permissions: dto.permissions, previousRole: target.role } },
      });
      return user;
    });
    await this.notifications.notify(target.id, 'STAFF_ACCESS_CHANGED', { roleLabel: STAFF_ROLE_LABEL[dto.staffRole] });
    return shape(updated);
  }

  async update(actorId: string, targetId: string, dto: UpdateStaffDto) {
    const actor = await this.actorOf(actorId);
    if (targetId === actorId) throw new ForbiddenException('Vous ne pouvez pas modifier votre propre compte.');
    const target = await this.prisma.user.findUnique({ where: { id: targetId }, select: MEMBER_SELECT });
    if (!target || target.role !== 'ADMIN') throw new NotFoundException('Membre introuvable.');

    this.assertCanGrant(actor, dto.staffRole, dto.permissions);
    const targetIsSuper = effectiveStaffRole(target) === 'SUPER_ADMIN';
    if (targetIsSuper && effectiveStaffRole(actor) !== 'SUPER_ADMIN') throw new ForbiddenException('Seul un super administrateur peut modifier un super administrateur.');
    if (targetIsSuper && dto.staffRole !== 'SUPER_ADMIN' && (await this.otherSuperAdmins(targetId)) === 0) {
      throw new ConflictException('Il doit rester au moins un super administrateur.');
    }

    const before = { staffRole: effectiveStaffRole(target), permissions: target.staffPermissions };
    const updated = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.update({ where: { id: targetId }, data: { staffRole: dto.staffRole, staffPermissions: dto.permissions }, select: MEMBER_SELECT });
      await tx.auditLog.create({
        data: { actorId, action: 'staff.update', targetType: 'User', targetId, meta: { before, after: { staffRole: dto.staffRole, permissions: dto.permissions } } },
      });
      return user;
    });
    await this.notifications.notify(targetId, 'STAFF_ACCESS_CHANGED', { roleLabel: STAFF_ROLE_LABEL[dto.staffRole] });
    return shape(updated);
  }

  async remove(actorId: string, targetId: string) {
    const actor = await this.actorOf(actorId);
    if (targetId === actorId) throw new ForbiddenException('Vous ne pouvez pas retirer votre propre compte.');
    const target = await this.prisma.user.findUnique({ where: { id: targetId }, select: { ...MEMBER_SELECT, hostProfile: { select: { userId: true } } } });
    if (!target || target.role !== 'ADMIN') throw new NotFoundException('Membre introuvable.');

    const targetIsSuper = effectiveStaffRole(target) === 'SUPER_ADMIN';
    if (targetIsSuper && effectiveStaffRole(actor) !== 'SUPER_ADMIN') throw new ForbiddenException('Seul un super administrateur peut retirer un super administrateur.');
    if (targetIsSuper && (await this.otherSuperAdmins(targetId)) === 0) throw new ConflictException('Il doit rester au moins un super administrateur.');

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: targetId }, data: { role: target.hostProfile ? 'HOST' : 'TRAVELER', staffRole: null, staffPermissions: [] } });
      // Ce qui lui était confié n'est pas perdu : tâches et demandes redeviennent « non assignées ».
      await tx.staffTask.updateMany({ where: { assigneeId: targetId, status: { not: 'DONE' } }, data: { assigneeId: null } });
      await tx.supportTicket.updateMany({ where: { assigneeId: targetId, status: { in: ['OPEN', 'IN_PROGRESS', 'WAITING_USER'] } }, data: { assigneeId: null } });
      await tx.auditLog.create({ data: { actorId, action: 'staff.remove', targetType: 'User', targetId, meta: { previousStaffRole: effectiveStaffRole(target) } } });
    });
    await this.notifications.notify(targetId, 'STAFF_ACCESS_CHANGED', { roleLabel: null });
    return { ok: true };
  }
}

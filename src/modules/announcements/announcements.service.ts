/**
 * Annonces de l'équipe aux utilisateurs.
 *
 * Une annonce est d'abord un brouillon (modifiable, supprimable). La publier est irréversible : elle
 * devient une notification pour chaque personne du public visé, puis ne peut plus être modifiée.
 * Le passage brouillon → publiée est atomique (un seul clic vainqueur : pas de double envoi) et écrit
 * dans le journal d'audit dans la même transaction.
 */
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type { AnnouncementDto } from './dto/announcements.dto.js';

const CHUNK = 500;
const ROLES_BY_AUDIENCE = { ALL: undefined, TRAVELERS: ['TRAVELER'], HOSTS: ['HOST'] } as const;

@Injectable()
export class AnnouncementsService {
  private readonly logger = new Logger(AnnouncementsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  list() {
    return this.prisma.announcement.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, title: true, body: true, href: true, audience: true, status: true, publishedAt: true, recipientCount: true, createdAt: true, author: { select: { fullName: true } } },
    });
  }

  create(authorId: string, dto: AnnouncementDto) {
    return this.prisma.announcement.create({ data: { ...dto, authorId } });
  }

  async update(id: string, dto: AnnouncementDto) {
    const { count } = await this.prisma.announcement.updateMany({ where: { id, status: 'DRAFT' }, data: dto });
    if (count === 0) await this.explainRefusal(id);
    return this.prisma.announcement.findUnique({ where: { id } });
  }

  async remove(id: string) {
    const { count } = await this.prisma.announcement.deleteMany({ where: { id, status: 'DRAFT' } });
    if (count === 0) await this.explainRefusal(id);
    return { ok: true };
  }

  /** Aucune ligne touchée : l'annonce n'existe pas, ou elle est déjà publiée. */
  private async explainRefusal(id: string): Promise<never> {
    const exists = await this.prisma.announcement.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException('Annonce introuvable.');
    throw new ConflictException('Cette annonce est déjà publiée : elle ne peut plus être modifiée.');
  }

  async publish(actorId: string, id: string) {
    const announcement = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.announcement.updateMany({ where: { id, status: 'DRAFT' }, data: { status: 'PUBLISHED', publishedAt: new Date() } });
      if (count === 0) return null;
      const row = await tx.announcement.findUniqueOrThrow({ where: { id } });
      await tx.auditLog.create({
        data: { actorId, action: 'announcement.publish', targetType: 'Announcement', targetId: id, meta: { audience: row.audience } },
      });
      return row;
    });
    if (!announcement) return this.explainRefusal(id);

    const roles = ROLES_BY_AUDIENCE[announcement.audience];
    const users = await this.prisma.user.findMany({ where: roles ? { role: { in: [...roles] } } : {}, select: { id: true } });
    const payload = { title: announcement.title, body: announcement.body, href: announcement.href ?? undefined };
    for (let i = 0; i < users.length; i += CHUNK) {
      await this.notifications.notifyMany(users.slice(i, i + CHUNK).map((u) => u.id), 'ANNOUNCEMENT', payload);
    }
    await this.prisma.announcement.update({ where: { id }, data: { recipientCount: users.length } });
    this.logger.log(`Annonce ${id} publiée pour ${users.length} personne(s).`);
    return { ...announcement, recipientCount: users.length };
  }
}

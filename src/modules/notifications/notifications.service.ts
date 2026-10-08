/**
 * Notifications dans l'application. Principe central : une notification est un effet secondaire, jamais
 * une condition. Si son écriture échoue, le paiement, la réservation ou la décision qui l'a déclenchée
 * doit quand même réussir — `notify` n'échoue donc jamais, il écrit l'erreur dans les journaux.
 */
import { Injectable, Logger } from '@nestjs/common';
import { permissionsFor, type Permission } from '../admin/permissions.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { renderNotification, type NotificationPayloads, type NotificationType } from './notification-types.js';

const MAX_PAGE = 50;

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Notifie une personne. Ne lève jamais d'erreur. Renvoie true si la notification est écrite. */
  async notify<T extends NotificationType>(userId: string, type: T, payload: NotificationPayloads[T]): Promise<boolean> {
    try {
      const { title, body, linkUrl } = renderNotification(type, payload);
      await this.prisma.notification.create({ data: { userId, type, title, body, linkUrl } });
      return true;
    } catch (error) {
      this.logger.error(`Notification ${type} non écrite pour ${userId} : ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** Notifie plusieurs personnes à la fois (une seule fois chacune). Ne lève jamais d'erreur. */
  async notifyMany<T extends NotificationType>(userIds: string[], type: T, payload: NotificationPayloads[T]): Promise<void> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return;
    try {
      const { title, body, linkUrl } = renderNotification(type, payload);
      await this.prisma.notification.createMany({ data: unique.map((userId) => ({ userId, type, title, body, linkUrl })) });
    } catch (error) {
      this.logger.error(`Notification ${type} non écrite pour ${unique.length} personne(s) : ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Prévient les membres de l'équipe qui ont l'accès voulu (et eux seulement) : une demande d'identité
   * n'a pas à alerter le support. `exceptUserId` évite d'alerter la personne à l'origine de l'événement.
   */
  async notifyStaff<T extends NotificationType>(
    permission: Permission,
    type: T,
    payload: NotificationPayloads[T],
    exceptUserId?: string,
  ): Promise<void> {
    try {
      const admins = await this.prisma.user.findMany({
        where: { role: 'ADMIN' },
        select: { id: true, role: true, staffRole: true, staffPermissions: true },
      });
      const recipients = admins.filter((a) => a.id !== exceptUserId && permissionsFor(a).includes(permission)).map((a) => a.id);
      await this.notifyMany(recipients, type, payload);
    } catch (error) {
      this.logger.error(`Alerte équipe ${type} non envoyée : ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Les plus récentes d'abord. `before` (date ISO) pour charger la suite. */
  async listMine(userId: string, opts: { unreadOnly?: boolean; limit?: number; before?: string } = {}) {
    const take = Math.min(Math.max(Math.trunc(opts.limit ?? 30) || 30, 1), MAX_PAGE);
    const before = opts.before ? new Date(opts.before) : undefined;
    const rows = await this.prisma.notification.findMany({
      where: {
        userId,
        readAt: opts.unreadOnly ? null : undefined,
        createdAt: before && !Number.isNaN(before.getTime()) ? { lt: before } : undefined,
      },
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      select: { id: true, type: true, title: true, body: true, linkUrl: true, readAt: true, createdAt: true },
    });
    const hasMore = rows.length > take;
    return { items: hasMore ? rows.slice(0, take) : rows, hasMore };
  }

  async unreadCount(userId: string) {
    return { count: await this.prisma.notification.count({ where: { userId, readAt: null } }) };
  }

  /** Ne touche que les notifications de la personne connectée : l'identifiant seul ne suffit jamais. */
  async markRead(userId: string, notificationId: string) {
    await this.prisma.notification.updateMany({ where: { id: notificationId, userId, readAt: null }, data: { readAt: new Date() } });
    return this.unreadCount(userId);
  }

  async markAllRead(userId: string) {
    await this.prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
    return { count: 0 };
  }
}

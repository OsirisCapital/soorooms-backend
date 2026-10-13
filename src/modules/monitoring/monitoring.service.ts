/**
 * Surveillance des erreurs serveur (5xx). Principe central : surveiller ne doit jamais casser ce qu'on surveille.
 * `report` ne lève JAMAIS d'erreur et n'est pas attendu par l'appelant.
 *
 * Les erreurs sont regroupées par empreinte (méthode + chemin normalisé + message) : un problème qui se répète
 * 500 fois fait UNE ligne avec un compteur, et alerte l'équipe à la première fois, quand il revient après avoir
 * été marqué résolu, puis à 10, 100, 1000… occurrences — pas à chaque requête.
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { describeError, fingerprint, normalizeMessage, normalizePath, shouldAlert } from './monitoring.utils.js';

export type ErrorReport = { method: string; path: string; status: number; error: unknown; userId?: string | null };

@Injectable()
export class MonitoringService {
  private readonly logger = new Logger(MonitoringService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async report(input: ErrorReport): Promise<void> {
    try {
      const { message, stack } = describeError(input.error);
      const cleanMessage = normalizeMessage(message) || 'Erreur sans message';
      const path = normalizePath(input.path);
      const key = fingerprint(input.method, input.path, cleanMessage);
      const now = new Date();

      const existing = await this.prisma.errorEvent.findUnique({ where: { fingerprint: key }, select: { id: true, resolvedAt: true, count: true } });
      let count: number;
      let isNew = false;
      let reopened = false;
      if (!existing) {
        isNew = true;
        count = 1;
        await this.prisma.errorEvent.create({
          data: { fingerprint: key, method: input.method.toUpperCase(), path, status: input.status, message: cleanMessage, stack, lastUserId: input.userId ?? null },
        });
      } else {
        reopened = existing.resolvedAt !== null;
        count = existing.count + 1;
        await this.prisma.errorEvent.update({
          where: { id: existing.id },
          data: { count: { increment: 1 }, lastSeenAt: now, stack, status: input.status, lastUserId: input.userId ?? null, resolvedAt: null },
        });
      }

      if (shouldAlert({ isNew, reopened, count })) {
        await this.notifications.notifyStaff('audit.view', 'ERROR_ALERT_STAFF', { message: cleanMessage, path, count, reopened });
      }
    } catch (error) {
      // La surveillance qui échoue ne doit pas ajouter une erreur à l'erreur : on se contente de le dire dans les journaux.
      this.logger.error(`Erreur non enregistrée : ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Erreurs ouvertes d'abord (les plus récentes en tête), puis les résolues. */
  async list(includeResolved: boolean) {
    const [items, open, last24h] = await Promise.all([
      this.prisma.errorEvent.findMany({
        where: includeResolved ? {} : { resolvedAt: null },
        orderBy: [{ lastSeenAt: 'desc' }],
        take: 100,
      }),
      this.prisma.errorEvent.count({ where: { resolvedAt: null } }),
      this.prisma.errorEvent.count({ where: { lastSeenAt: { gte: new Date(Date.now() - 24 * 3_600_000) }, resolvedAt: null } }),
    ]);
    return { open, last24h, items };
  }

  async resolve(id: string) {
    const res = await this.prisma.errorEvent.updateMany({ where: { id, resolvedAt: null }, data: { resolvedAt: new Date() } });
    if (res.count === 0) {
      const exists = await this.prisma.errorEvent.findUnique({ where: { id }, select: { id: true } });
      if (!exists) throw new NotFoundException('Erreur introuvable.');
    }
    return { resolved: true };
  }

  /** Vrai si la base répond : sert à la route de santé. */
  async databaseReachable(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}

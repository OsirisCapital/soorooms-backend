/**
 * Journal des actions sensibles de l'équipe : qui, quoi, quand. On n'y écrit jamais le contenu d'un
 * document ni une adresse de fichier — seulement des identifiants.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

export type AuditEntry = {
  actorId: string;
  /** Verbe stable, en minuscules, par exemple « kyc.document.view ». */
  action: string;
  targetType?: string;
  targetId?: string;
  meta?: Prisma.InputJsonValue;
};

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  record(entry: AuditEntry) {
    return this.prisma.auditLog.create({
      data: {
        actorId: entry.actorId,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        meta: entry.meta,
      },
    });
  }

  /** Les entrées les plus récentes d'abord. `limit` borné pour ne jamais renvoyer tout le journal. */
  async listRecent(limit = 100) {
    const take = Math.min(Math.max(Math.trunc(limit) || 100, 1), 200);
    const rows = await this.prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take,
      include: { actor: { select: { id: true, fullName: true } } },
    });
    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      createdAt: row.createdAt,
      actor: row.actor,
    }));
  }
}

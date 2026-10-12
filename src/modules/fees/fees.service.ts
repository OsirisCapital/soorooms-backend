/**
 * Réglages des commissions et frais. Lecture pour tout le monde (taux publics), écriture réservée au
 * super administrateur. Chaque modification ajoute une ligne (historique) et prévient les personnes concernées.
 */
import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type { UpdateFeesDto } from './dto/update-fees.dto.js';
import { ratesAt, type FeeSettings } from './fees.utils.js';

type Row = {
  id: string;
  hostCommissionPercent: { toString(): string };
  launchHostCommissionPercent: { toString(): string } | null;
  launchEndsAt: Date | null;
  travelerFeePercent: { toString(): string };
  note: string | null;
  createdById: string | null;
  createdAt: Date;
};

const num = (value: { toString(): string }) => Number(value.toString());
const toSettings = (row: Row): FeeSettings => ({
  hostCommissionPercent: num(row.hostCommissionPercent),
  launchHostCommissionPercent: row.launchHostCommissionPercent == null ? null : num(row.launchHostCommissionPercent),
  launchEndsAt: row.launchEndsAt,
  travelerFeePercent: num(row.travelerFeePercent),
});

@Injectable()
export class FeesService {
  private readonly logger = new Logger(FeesService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  private latest() {
    return this.prisma.platformFeeConfig.findFirst({ orderBy: { createdAt: 'desc' } });
  }

  /** Réglages en vigueur, ou null si la table est vide (l'appelant retombe alors sur la configuration d'environnement). */
  async currentSettings(): Promise<FeeSettings | null> {
    const row = await this.latest();
    return row ? toSettings(row as Row) : null;
  }

  /** Taux appliqués maintenant : offre de lancement comprise. */
  async currentRates(now = new Date()) {
    const settings = await this.currentSettings();
    return settings ? ratesAt(settings, now) : null;
  }

  /** Taux annoncés aux utilisateurs connectés (hôte : sa commission ; voyageur : ses frais). */
  async publicView(now = new Date()) {
    const settings = await this.currentSettings();
    if (!settings) return null;
    const rates = ratesAt(settings, now);
    return {
      hostCommissionPercent: rates.hostCommissionPercent,
      travelerFeePercent: rates.travelerFeePercent,
      launchActive: rates.launchActive,
      launchEndsAt: rates.launchActive ? settings.launchEndsAt : null,
      standardHostCommissionPercent: settings.hostCommissionPercent,
    };
  }

  /** Page du super administrateur : réglages, taux appliqués et historique (20 dernières modifications). */
  async adminView(now = new Date()) {
    const rows = (await this.prisma.platformFeeConfig.findMany({ orderBy: { createdAt: 'desc' }, take: 20 })) as Row[];
    const authorIds = [...new Set(rows.map((r) => r.createdById).filter((id): id is string => !!id))];
    const authors = authorIds.length ? await this.prisma.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, fullName: true } }) : [];
    const nameOf = new Map(authors.map((a) => [a.id, a.fullName]));
    const history = rows.map((row) => ({
      id: row.id,
      ...toSettings(row),
      note: row.note,
      by: row.createdById ? (nameOf.get(row.createdById) ?? null) : null,
      createdAt: row.createdAt,
    }));
    const current = history[0] ?? null;
    return { current, applied: current ? ratesAt(current, now) : null, history };
  }

  async update(adminId: string, dto: UpdateFeesDto, now = new Date()) {
    const hasPercent = dto.launchHostCommissionPercent != null;
    const hasDate = dto.launchEndsAt != null;
    if (hasPercent !== hasDate) {
      throw new BadRequestException("L'offre de lancement demande un pourcentage ET une date de fin (ou aucun des deux pour la retirer).");
    }
    if (hasDate && (dto.launchEndsAt as Date).getTime() <= now.getTime()) {
      throw new BadRequestException("La date de fin de l'offre de lancement doit être dans le futur.");
    }

    const before = await this.currentSettings();
    const created = (await this.prisma.platformFeeConfig.create({
      data: {
        hostCommissionPercent: dto.hostCommissionPercent,
        launchHostCommissionPercent: hasPercent ? dto.launchHostCommissionPercent : null,
        launchEndsAt: hasDate ? dto.launchEndsAt : null,
        travelerFeePercent: dto.travelerFeePercent,
        note: dto.note?.trim() || null,
        createdById: adminId,
      },
    })) as Row;
    const after = toSettings(created);

    await this.prisma.auditLog
      .create({
        data: {
          actorId: adminId,
          action: 'fees.update',
          targetType: 'PlatformFeeConfig',
          targetId: created.id,
          meta: {
            hostCommissionPercent: after.hostCommissionPercent,
            launchHostCommissionPercent: after.launchHostCommissionPercent,
            launchEndsAt: after.launchEndsAt?.toISOString() ?? null,
            travelerFeePercent: after.travelerFeePercent,
          },
        },
      })
      .catch((error: unknown) => this.logger.error(`Journal non écrit : ${error instanceof Error ? error.message : String(error)}`));

    await this.announce(before, after, adminId, now);
    return this.adminView(now);
  }

  /** Prévient l'équipe de toute modification, et les hôtes quand LEUR commission appliquée change. */
  private async announce(before: FeeSettings | null, after: FeeSettings, adminId: string, now: Date) {
    if (!this.notifications) return;
    const rates = ratesAt(after, now);
    const previous = before ? ratesAt(before, now) : null;

    await this.notifications.notifyStaff(
      'settings.manage',
      'FEES_CHANGED_STAFF',
      { hostPercent: rates.hostCommissionPercent, travelerPercent: rates.travelerFeePercent },
      adminId,
    );

    const hostChanged = !previous || previous.hostCommissionPercent !== rates.hostCommissionPercent || before?.launchEndsAt?.getTime() !== after.launchEndsAt?.getTime();
    if (hostChanged) {
      const hosts = await this.prisma.user.findMany({ where: { role: 'HOST' }, select: { id: true } });
      await this.notifications.notifyMany(
        hosts.map((h) => h.id),
        'FEES_CHANGED_HOST',
        {
          hostPercent: rates.hostCommissionPercent,
          standardPercent: after.hostCommissionPercent,
          launchEndsAt: rates.launchActive && after.launchEndsAt ? after.launchEndsAt.toISOString().slice(0, 10) : undefined,
        },
      );
    }
  }
}

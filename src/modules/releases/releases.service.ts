/**
 * Versions de l'application et mise à jour obligatoire.
 *
 * Principe : l'application sait quelle version elle est (numéro dans le code). Elle demande ici quelle
 * est la dernière version et la plus ancienne encore acceptée. Plus ancienne que celle-ci → écran de
 * mise à jour obligatoire ; plus ancienne que la dernière → simple bandeau. En cas d'erreur réseau,
 * l'application ne bloque jamais l'utilisateur.
 *
 * Garde-fous : une nouvelle version doit être plus haute que la dernière (pas de retour en arrière),
 * l'historique ne se supprime pas, chaque publication est écrite dans le journal d'audit, et le
 * caractère « obligatoire » peut être retiré si une version a été verrouillée par erreur.
 */
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { PublishReleaseDto } from './dto/releases.dto.js';
import { compareVersions } from './semver.js';

const NONE = '0.0.0';

@Injectable()
export class ReleasesService {
  constructor(private readonly prisma: PrismaService) {}

  private async all() {
    return this.prisma.appRelease.findMany({ orderBy: { publishedAt: 'desc' }, take: 200 });
  }

  /** Réponse publique : rien de sensible, seulement ce dont l'application a besoin. */
  async current() {
    const releases = await this.all();
    if (releases.length === 0) return { latest: NONE, minSupported: NONE, notes: '' };
    const latest = releases.reduce((a, b) => (compareVersions(b.version, a.version) > 0 ? b : a));
    const minSupported = releases.filter((r) => r.required).reduce((min, r) => (compareVersions(r.version, min) > 0 ? r.version : min), NONE);
    return { latest: latest.version, minSupported, notes: latest.notes };
  }

  async list() {
    const releases = await this.all();
    return releases.sort((a, b) => compareVersions(b.version, a.version));
  }

  async publish(actorId: string, dto: PublishReleaseDto) {
    const { latest } = await this.current();
    if (compareVersions(dto.version, latest) <= 0) {
      throw new ConflictException(`La version ${dto.version} doit être plus haute que la dernière version publiée (${latest}).`);
    }
    return this.prisma.$transaction(async (tx) => {
      const release = await tx.appRelease.create({
        data: { version: dto.version, notes: dto.notes, required: dto.required, publishedById: actorId },
      });
      await tx.auditLog.create({
        data: { actorId, action: 'release.publish', targetType: 'AppRelease', targetId: release.id, meta: { version: dto.version, required: dto.required } },
      });
      return release;
    });
  }

  /** Retire (ou remet) le caractère obligatoire d'une version — filet de sécurité contre un blocage par erreur. */
  async setRequired(actorId: string, id: string, required: boolean) {
    const release = await this.prisma.appRelease.findUnique({ where: { id } });
    if (!release) throw new NotFoundException('Version introuvable.');
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.appRelease.update({ where: { id }, data: { required } });
      await tx.auditLog.create({
        data: { actorId, action: 'release.required', targetType: 'AppRelease', targetId: id, meta: { version: release.version, required } },
      });
      return updated;
    });
  }
}

import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

/** Dossier des photos de profil envoyées depuis l'application (voir ASSET_RULES.avatar). */
const OWN_AVATAR_MARKER = '/soorooms/avatars/';

@Injectable()
export class ProfileService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Change ou retire la photo de la personne connectée (l'identifiant vient du jeton, jamais de la requête).
   *
   * La photo sert à vérifier l'identité : tant qu'une vérification est en cours ou approuvée, la photo
   * choisie pour elle ne peut plus changer, sinon le visage affiché ne serait plus celui qui a été contrôlé.
   * Après un refus, ou pour un compte jamais vérifié, elle reste libre. Le contrôle est dans la requête
   * d'écriture elle-même : pas de fenêtre entre « on vérifie » et « on écrit ».
   */
  async setAvatar(userId: string, avatarUrl: string | null) {
    const result = await this.prisma.user.updateMany({
      where: {
        id: userId,
        NOT: { kycStatus: { in: ['PENDING_REVIEW', 'APPROVED'] }, avatarUrl: { contains: OWN_AVATAR_MARKER } },
      },
      data: { avatarUrl },
    });
    if (result.count > 0) return { avatarUrl };

    const exists = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!exists) throw new NotFoundException('Compte introuvable.');
    throw new ConflictException(
      "Votre photo de profil est liée à la vérification de votre identité : elle ne peut plus être modifiée. Pour la changer, contactez le support.",
    );
  }
}

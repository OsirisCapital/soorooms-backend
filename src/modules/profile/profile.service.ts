import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

@Injectable()
export class ProfileService {
  constructor(private readonly prisma: PrismaService) {}

  /** Ne modifie que le compte de la personne connectée : l'identifiant vient du jeton, jamais de la requête. */
  async setAvatar(userId: string, avatarUrl: string | null) {
    const result = await this.prisma.user.updateMany({ where: { id: userId }, data: { avatarUrl } });
    if (result.count === 0) throw new NotFoundException('Compte introuvable.');
    return { avatarUrl };
  }
}

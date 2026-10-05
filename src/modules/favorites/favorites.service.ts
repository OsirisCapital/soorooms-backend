/**
 * Favoris (étoile) d'un utilisateur : on met de côté des logements, pas des
 * chambres — c'est la fiche du logement que le voyageur veut retrouver.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

@Injectable()
export class FavoritesService {
  constructor(private readonly prisma: PrismaService) {}

  // Les logements qui ne sont plus publiés disparaissent de la liste sans
  // être supprimés des favoris : ils réapparaissent s'ils sont republiés.
  async list(userId: string) {
    const favorites = await this.prisma.favorite.findMany({
      where: { userId, property: { status: 'ACTIVE' } },
      include: {
        property: {
          include: { rooms: true, photos: { orderBy: { position: 'asc' } } },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return favorites.map((favorite) => favorite.property);
  }

  // Identifiants seuls : de quoi afficher l'état de l'étoile sur n'importe
  // quelle carte sans recharger les logements.
  async listIds(userId: string) {
    const favorites = await this.prisma.favorite.findMany({
      where: { userId },
      select: { propertyId: true },
    });
    return favorites.map((favorite) => favorite.propertyId);
  }

  // Idempotent : ajouter deux fois le même logement ne crée pas de doublon.
  async add(userId: string, propertyId: string) {
    const property = await this.prisma.property.findUnique({ where: { id: propertyId } });
    if (!property || property.status !== 'ACTIVE') {
      throw new NotFoundException('Logement introuvable.');
    }
    await this.prisma.favorite.upsert({
      where: { userId_propertyId: { userId, propertyId } },
      create: { userId, propertyId },
      update: {},
    });
    return { propertyId };
  }

  // Idempotent aussi : retirer un favori absent n'est pas une erreur.
  async remove(userId: string, propertyId: string) {
    await this.prisma.favorite.deleteMany({ where: { userId, propertyId } });
  }
}

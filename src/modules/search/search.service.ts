/**
 * Recherche publique de chambres/studios parmi les logements ACTIVE
 * uniquement — jamais DRAFT, PENDING_KYC ou SUSPENDED, qui ne doivent pas
 * être visibles avant validation complète (KYC + publication explicite).
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { SearchRoomsQueryDto } from './dto/search-rooms.query.dto.js';

// Mêmes statuts qu'utilisés dans BookingsService pour verrouiller le
// calendrier — une négociation en cours (NEGOTIATING) ne rend pas une
// chambre indisponible pour les autres recherches.
const BLOCKING_STATUSES = ['PENDING_PAYMENT', 'CONFIRMED_ESCROW', 'COMPLETED'] as const;

@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  async searchRooms(query: SearchRoomsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    // Construction dynamique du filtre : Prisma type strictement la forme
    // exacte de `where` selon le schéma, mais cette forme varie ici selon
    // les paramètres réellement fournis. `any` reste local à cette
    // fonction et est validé de toute façon par Prisma à l'exécution.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const propertyWhere: any = { status: 'ACTIVE' };
    if (query.city) propertyWhere.city = { equals: query.city, mode: 'insensitive' };
    if (query.quarter) propertyWhere.quarter = { equals: query.quarter, mode: 'insensitive' };
    if (query.propertyType) propertyWhere.propertyType = query.propertyType;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const amenityWhere: any = {};
    if (query.hasWifi !== undefined) amenityWhere.hasWifi = query.hasWifi;
    if (query.hasGeneratorOrSolar !== undefined) amenityWhere.hasGeneratorOrSolar = query.hasGeneratorOrSolar;
    if (query.hasAc !== undefined) amenityWhere.hasAc = query.hasAc;
    if (query.hasParking !== undefined) amenityWhere.hasParking = query.hasParking;
    if (Object.keys(amenityWhere).length > 0) propertyWhere.amenities = amenityWhere;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const roomWhere: any = { property: propertyWhere };
    if (query.minPrice !== undefined || query.maxPrice !== undefined) {
      roomWhere.basePrice = {};
      if (query.minPrice !== undefined) roomWhere.basePrice.gte = query.minPrice;
      if (query.maxPrice !== undefined) roomWhere.basePrice.lte = query.maxPrice;
    }
    if (query.maxGuests !== undefined) {
      roomWhere.maxGuests = { gte: query.maxGuests };
    }
    // Disponibilité réelle : on exclut toute chambre ayant déjà une
    // réservation qui bloque le calendrier (payée ou en cours) et qui
    // chevauche les dates demandées — sans ce filtre, un voyageur pourrait
    // négocier sur une chambre déjà prise pour ses dates.
    if (query.checkInDate && query.checkOutDate) {
      const checkIn = new Date(query.checkInDate);
      const checkOut = new Date(query.checkOutDate);
      roomWhere.bookings = {
        none: {
          status: { in: [...BLOCKING_STATUSES] },
          checkInDate: { lt: checkOut },
          checkOutDate: { gt: checkIn },
        },
      };
    }

    const [results, total] = await Promise.all([
      this.prisma.room.findMany({
        where: roomWhere,
        include: {
          property: { include: { amenities: true, photos: { orderBy: { position: 'asc' } } } },
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { basePrice: 'asc' },
      }),
      this.prisma.room.count({ where: roomWhere }),
    ]);

    return { results, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
  }

  async findActiveProperty(propertyId: string) {
    const property = await this.prisma.property.findUnique({
      where: { id: propertyId },
      include: { amenities: true, rooms: true, photos: { orderBy: { position: 'asc' } } },
    });
    // Message volontairement identique, que le logement n'existe pas ou
    // qu'il ne soit simplement pas encore publié — on ne révèle pas
    // l'existence d'annonces non publiées à un voyageur non concerné.
    if (!property || property.status !== 'ACTIVE') {
      throw new NotFoundException('Logement introuvable.');
    }
    return property;
  }
}

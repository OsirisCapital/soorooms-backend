/**
 * Recherche publique de chambres/studios parmi les logements ACTIVE
 * uniquement — jamais DRAFT, PENDING_KYC ou SUSPENDED, qui ne doivent pas
 * être visibles avant validation complète (KYC + publication explicite).
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { DEFAULT_COUNTRY, findCountry } from '../../common/utils/countries.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { BLOCKING_STATUSES, unitsLeft } from '../rooms/availability.utils.js';
import { blockAsStay } from '../rooms/blocks.utils.js';
import type { SearchRoomsQueryDto } from './dto/search-rooms.query.dto.js';

// Mêmes statuts que BookingsService pour verrouiller le calendrier (voir availability.utils).

// Seul le statut KYC du gestionnaire sert à poser le badge : on n'expose jamais l'équipe elle-même.
const HOST_KYC = { where: { role: 'MANAGER' as const }, select: { user: { select: { kycStatus: true } } } };

type WithCollaborators = { collaborators?: { user: { kycStatus: string } }[] };

/** Badge « identité vérifiée » : au moins un gestionnaire dont le KYC est approuvé. */
export function hostIdentityVerified(property: WithCollaborators): boolean {
  return (property.collaborators ?? []).some((c) => c.user.kycStatus === 'APPROVED');
}

function stripCollaborators<T extends WithCollaborators>(property: T) {
  const { collaborators, ...rest } = property;
  void collaborators;
  return { ...rest, identityVerified: hostIdentityVerified(property) };
}

function withVerification<T extends { property: WithCollaborators }>(room: T) {
  return { ...room, property: stripCollaborators(room.property) };
}

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
    const country = findCountry(query.country);
    if (query.country && !country) {
      // Pays non pris en charge : aucun logement, plutôt qu'une recherche silencieusement élargie.
      return { results: [], page, limit, total: 0, totalPages: 1 };
    }
    if (country) {
      propertyWhere.OR = [
        { country: { equals: country.name, mode: 'insensitive' } },
        ...(country.name === DEFAULT_COUNTRY ? [{ country: null }] : []),
      ];
    }
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
    // Mode sieste : le tarif de référence est celui de la sieste, et l'ampoule peut être imposée.
    const napMode = query.nap === true;
    if (napMode) {
      roomWhere.allowsNap = true;
      if (query.napBulb !== undefined) roomWhere.napBulb = query.napBulb;
    }
    const priceField = napMode ? 'napPrice' : 'basePrice';
    if (query.minPrice !== undefined || query.maxPrice !== undefined) {
      roomWhere[priceField] = {};
      if (query.minPrice !== undefined) roomWhere[priceField].gte = query.minPrice;
      if (query.maxPrice !== undefined) roomWhere[priceField].lte = query.maxPrice;
    }
    if (query.maxGuests !== undefined) {
      roomWhere.maxGuests = { gte: query.maxGuests };
    }
    // « Vérifiés d'abord » : logements vérifiés sur place en tête, puis prix croissant.
    const orderBy =
      query.sort === 'verified'
        ? [{ property: { isVerifiedByAgent: 'desc' as const } }, { [napMode ? 'napPrice' : 'basePrice']: 'asc' as const }]
        : [{ [napMode ? 'napPrice' : 'basePrice']: 'asc' as const }];

    const roomInclude = {
      property: { include: { amenities: true, photos: { orderBy: { position: 'asc' as const } }, collaborators: HOST_KYC } },
      photos: { orderBy: { position: 'asc' as const } },
    };

    // Sans dates : pas de calcul de disponibilité, on affiche le total d'unités.
    // En mode sieste, la disponibilité se vérifie à la réservation (heure par heure).
    if (napMode || !(query.checkInDate && query.checkOutDate)) {
      const [rooms, total] = await Promise.all([
        this.prisma.room.findMany({
          where: roomWhere,
          include: roomInclude,
          skip: (page - 1) * limit,
          take: limit,
          orderBy,
        }),
        this.prisma.room.count({ where: roomWhere }),
      ]);
      const results = rooms.map((r) => ({ ...withVerification(r), unitsLeft: r.unitCount }));
      return { results, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
    }

    // Avec dates : un type est proposé tant qu'il lui reste au moins une unité libre sur
    // toutes les nuits du séjour. Le calcul se fait en mémoire, puis on pagine.
    const checkIn = new Date(query.checkInDate);
    const checkOut = new Date(query.checkOutDate);
    const candidates = await this.prisma.room.findMany({
      where: roomWhere,
      include: {
        ...roomInclude,
        bookings: {
          where: {
            status: { in: [...BLOCKING_STATUSES] },
            napStartHour: null,
            checkInDate: { lt: checkOut },
            checkOutDate: { gt: checkIn },
          },
          select: { checkInDate: true, checkOutDate: true, units: true },
        },
        blocks: { where: { startDate: { lt: checkOut }, endDate: { gt: checkIn } }, select: { startDate: true, endDate: true, units: true } },
      },
      orderBy,
    });
    const available = candidates
      .map(({ bookings, blocks, ...room }) => ({
        ...withVerification(room),
        unitsLeft: unitsLeft(room.unitCount, [...bookings, ...blocks.map((b) => blockAsStay(b, room.unitCount))], checkIn, checkOut),
      }))
      .filter((r) => r.unitsLeft > 0);
    const results = available.slice((page - 1) * limit, page * limit);
    const total = available.length;
    return { results, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
  }

  async findActiveProperty(propertyId: string, checkInDate?: string, checkOutDate?: string) {
    const checkIn = checkInDate && checkOutDate ? new Date(checkInDate) : null;
    const checkOut = checkInDate && checkOutDate ? new Date(checkOutDate) : null;
    const property = await this.prisma.property.findUnique({
      where: { id: propertyId },
      include: {
        amenities: true,
        hallOptions: { orderBy: { createdAt: 'asc' } },
        photos: { orderBy: { position: 'asc' } },
        collaborators: HOST_KYC,
        rooms: {
          include: {
            photos: { orderBy: { position: 'asc' } },
            // Sans dates, on regarde les séjours à venir ; avec dates, ceux qui les chevauchent.
            bookings: {
              where: {
                status: { in: [...BLOCKING_STATUSES] },
                napStartHour: null,
                ...(checkIn && checkOut
                  ? { checkInDate: { lt: checkOut }, checkOutDate: { gt: checkIn } }
                  : { checkOutDate: { gt: new Date() } }),
              },
              select: { checkInDate: true, checkOutDate: true, units: true },
            },
            blocks: {
              where: checkIn && checkOut ? { startDate: { lt: checkOut }, endDate: { gt: checkIn } } : { endDate: { gt: new Date() } },
              select: { startDate: true, endDate: true, units: true },
            },
          },
        },
      },
    });
    // Message volontairement identique, que le logement n'existe pas ou
    // qu'il ne soit simplement pas encore publié — on ne révèle pas
    // l'existence d'annonces non publiées à un voyageur non concerné.
    if (!property || property.status !== 'ACTIVE') {
      throw new NotFoundException('Logement introuvable.');
    }
    const rooms = property.rooms.map(({ bookings, blocks, ...room }) => {
      const occupied = [...bookings, ...blocks.map((b) => blockAsStay(b, room.unitCount))];
      return {
        ...room,
        // Sans dates, unitsLeft = unités libres aujourd'hui (sinon sur la période demandée).
        unitsLeft: checkIn && checkOut
          ? unitsLeft(room.unitCount, occupied, checkIn, checkOut)
          : unitsLeft(room.unitCount, occupied, startOfToday(), new Date(startOfToday().getTime() + 24 * 3_600_000)),
      };
    });
    return { ...stripCollaborators(property), rooms };
  }
}

function startOfToday(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

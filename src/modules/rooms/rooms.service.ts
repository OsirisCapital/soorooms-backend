/**
 * Gestion des chambres/studios rattachés à un établissement. Toute
 * opération vérifie explicitement que la chambre appartient bien au
 * propertyId de la route — sans ce contrôle, un collaborateur d'un
 * établissement pourrait modifier une chambre d'un autre établissement en
 * devinant son UUID (PropertyCollaboratorGuard vérifie l'accès à
 * l'établissement, pas l'appartenance de la chambre elle-même).
 */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { AddPhotoDto } from '../properties/dto/add-photo.dto.js';
import { BLOCKING_STATUSES, peakOccupancy } from './availability.utils.js';
import type { CreateRoomDto } from './dto/create-room.dto.js';
import type { UpdateRoomDto } from './dto/update-room.dto.js';

const WITH_PHOTOS = { photos: { orderBy: { position: 'asc' as const } } };

@Injectable()
export class RoomsService {
  constructor(private readonly prisma: PrismaService) {}

  list(propertyId: string) {
    return this.prisma.room.findMany({ where: { propertyId }, include: WITH_PHOTOS });
  }

  async create(propertyId: string, dto: CreateRoomDto) {
    await this.assertForfaitsForResidence(propertyId, dto);
    return this.prisma.room.create({ data: { propertyId, ...dto }, include: WITH_PHOTOS });
  }

  /** Une résidence étudiante se loue au forfait : au moins le semestre ou l'année doit avoir un prix. */
  private async assertForfaitsForResidence(propertyId: string, dto: { semesterPrice?: number | null; yearPrice?: number | null }, existing?: { semesterPrice: unknown; yearPrice: unknown }) {
    const property = await this.prisma.property.findUnique({ where: { id: propertyId }, select: { propertyType: true } });
    if (property?.propertyType !== 'STUDENT_RESIDENCE') return;
    const semester = dto.semesterPrice !== undefined ? dto.semesterPrice : (existing?.semesterPrice ?? null);
    const year = dto.yearPrice !== undefined ? dto.yearPrice : (existing?.yearPrice ?? null);
    if (semester == null && year == null) {
      throw new BadRequestException('Indiquez le prix du semestre et/ou de l\'année.');
    }
  }

  async update(propertyId: string, roomId: string, dto: UpdateRoomDto) {
    await this.assertRoomBelongsToProperty(propertyId, roomId);
    if (dto.semesterPrice !== undefined || dto.yearPrice !== undefined) {
      const current = await this.prisma.room.findUnique({ where: { id: roomId }, select: { semesterPrice: true, yearPrice: true } });
      await this.assertForfaitsForResidence(propertyId, dto, current ?? undefined);
    }
    if (dto.unitCount !== undefined) await this.assertEnoughUnitsForBookings(roomId, dto.unitCount);
    return this.prisma.room.update({ where: { id: roomId }, data: dto, include: WITH_PHOTOS });
  }

  /** Baisser le nombre d'unités sous ce que les réservations à venir occupent déjà créerait des doubles réservations. */
  private async assertEnoughUnitsForBookings(roomId: string, unitCount: number) {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const upcoming = await this.prisma.booking.findMany({
      where: { roomId, status: { in: [...BLOCKING_STATUSES] }, checkOutDate: { gt: today } },
      select: { checkInDate: true, checkOutDate: true },
    });
    if (upcoming.length === 0) return;
    const from = new Date(Math.min(...upcoming.map((b) => b.checkInDate.getTime())));
    const to = new Date(Math.max(...upcoming.map((b) => b.checkOutDate.getTime())));
    const peak = peakOccupancy(upcoming, from, to);
    if (unitCount < peak) {
      throw new ConflictException(
        `Impossible de descendre à ${unitCount} unité${unitCount > 1 ? 's' : ''} : jusqu'à ${peak} réservations à venir se chevauchent déjà sur ce type de chambre.`,
      );
    }
  }

  async remove(propertyId: string, roomId: string) {
    await this.assertRoomBelongsToProperty(propertyId, roomId);
    // Les réservations pointent vers la chambre sans suppression en cascade
    // (on ne perd jamais l'historique d'un paiement) : sans ce contrôle, la
    // suppression échouait en erreur 500 côté base de données.
    const bookingCount = await this.prisma.booking.count({ where: { roomId } });
    if (bookingCount > 0) {
      throw new ConflictException(
        'Cette chambre a des réservations : elle ne peut pas être supprimée. Modifiez-la plutôt.',
      );
    }
    // Un logement publié doit toujours proposer au moins une chambre réservable.
    const property = await this.prisma.property.findUnique({
      where: { id: propertyId },
      select: { status: true, _count: { select: { rooms: true } } },
    });
    if (property?.status === 'ACTIVE' && property._count.rooms <= 1) {
      throw new ConflictException(
        'C’est la seule chambre de ce logement publié : ajoutez-en une autre avant de la supprimer.',
      );
    }
    await this.prisma.room.delete({ where: { id: roomId } });
  }

  // --- Photos de la chambre ---------------------------------------------

  async addPhoto(propertyId: string, roomId: string, dto: AddPhotoDto) {
    await this.assertRoomBelongsToProperty(propertyId, roomId);
    let position = dto.position;
    if (position === undefined) {
      const last = await this.prisma.roomPhoto.findFirst({ where: { roomId }, orderBy: { position: 'desc' } });
      position = (last?.position ?? -1) + 1;
    }
    return this.prisma.roomPhoto.create({ data: { roomId, url: dto.url, position } });
  }

  async removePhoto(propertyId: string, roomId: string, photoId: string) {
    await this.assertRoomBelongsToProperty(propertyId, roomId);
    const photo = await this.prisma.roomPhoto.findUnique({ where: { id: photoId } });
    if (!photo || photo.roomId !== roomId) {
      throw new NotFoundException("Cette photo n'appartient pas à cette chambre.");
    }
    await this.prisma.roomPhoto.delete({ where: { id: photoId } });
  }

  private async assertRoomBelongsToProperty(propertyId: string, roomId: string) {
    const room = await this.prisma.room.findUnique({ where: { id: roomId } });
    if (!room || room.propertyId !== propertyId) {
      throw new NotFoundException("Cette chambre n'appartient pas à ce logement.");
    }
  }
}

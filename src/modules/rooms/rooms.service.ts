/**
 * Gestion des chambres/studios rattachés à un établissement. Toute
 * opération vérifie explicitement que la chambre appartient bien au
 * propertyId de la route — sans ce contrôle, un collaborateur d'un
 * établissement pourrait modifier une chambre d'un autre établissement en
 * devinant son UUID (PropertyCollaboratorGuard vérifie l'accès à
 * l'établissement, pas l'appartenance de la chambre elle-même).
 */
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { CreateRoomDto } from './dto/create-room.dto.js';
import type { UpdateRoomDto } from './dto/update-room.dto.js';

@Injectable()
export class RoomsService {
  constructor(private readonly prisma: PrismaService) {}

  list(propertyId: string) {
    return this.prisma.room.findMany({ where: { propertyId } });
  }

  create(propertyId: string, dto: CreateRoomDto) {
    return this.prisma.room.create({ data: { propertyId, ...dto } });
  }

  async update(propertyId: string, roomId: string, dto: UpdateRoomDto) {
    await this.assertRoomBelongsToProperty(propertyId, roomId);
    return this.prisma.room.update({ where: { id: roomId }, data: dto });
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
    await this.prisma.room.delete({ where: { id: roomId } });
  }

  private async assertRoomBelongsToProperty(propertyId: string, roomId: string) {
    const room = await this.prisma.room.findUnique({ where: { id: roomId } });
    if (!room || room.propertyId !== propertyId) {
      throw new NotFoundException("Cette chambre n'appartient pas à ce logement.");
    }
  }
}

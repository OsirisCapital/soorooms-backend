/**
 * Logique métier des établissements : création, édition, invitation de
 * collaborateurs, publication. Le principe central est celui décidé en
 * conception : une fiche unique par établissement, éditable par plusieurs
 * utilisateurs (PropertyCollaborator), jamais de doublons d'annonce.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type { AddPhotoDto } from './dto/add-photo.dto.js';
import type { CreatePropertyDto } from './dto/create-property.dto.js';
import type { InviteCollaboratorDto } from './dto/invite-collaborator.dto.js';
import type { UpdateAmenitiesDto } from './dto/update-amenities.dto.js';
import type { UpdatePropertyDto } from './dto/update-property.dto.js';

@Injectable()
export class PropertiesService {
  constructor(
    private readonly prisma: PrismaService,
    // Optionnel : une notification n'est jamais une condition de la publication.
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  // ---------------------------------------------------------------------
  // Création — le créateur devient automatiquement collaborateur MANAGER.
  // ---------------------------------------------------------------------

  async create(userId: string, dto: CreatePropertyDto) {
    return this.prisma.property.create({
      data: {
        ...dto,
        // status: PENDING_KYC par défaut (voir schema.prisma) — la fiche
        // existe et est éditable tout de suite, seule sa PUBLICATION est
        // bloquée tant que le KYC du MANAGER n'est pas approuvé.
        collaborators: {
          create: { userId, role: 'MANAGER' },
        },
        amenities: {
          create: {},
        },
      },
      include: { collaborators: true, amenities: true, photos: true },
    });
  }

  async listMine(userId: string) {
    const collaborations = await this.prisma.propertyCollaborator.findMany({
      where: { userId },
      include: { property: { include: { amenities: true, rooms: true, photos: true } } },
    });
    return collaborations.map((c) => ({ ...c.property, myRole: c.role }));
  }

  async findOne(propertyId: string) {
    const property = await this.prisma.property.findUnique({
      where: { id: propertyId },
      include: { amenities: true, rooms: true, collaborators: true, photos: { orderBy: { position: 'asc' } } },
    });
    if (!property) {
      throw new NotFoundException('Logement introuvable.');
    }
    return property;
  }

  // ---------------------------------------------------------------------
  // Édition — accessible à tout collaborateur (MANAGER ou AGENT), voir
  // PropertyCollaboratorGuard au niveau du contrôleur.
  // ---------------------------------------------------------------------

  async update(propertyId: string, dto: UpdatePropertyDto) {
    return this.prisma.property.update({ where: { id: propertyId }, data: dto });
  }

  async updateAmenities(propertyId: string, dto: UpdateAmenitiesDto) {
    return this.prisma.propertyAmenity.upsert({
      where: { propertyId },
      create: { propertyId, ...dto },
      update: dto,
    });
  }

  // ---------------------------------------------------------------------
  // Photos — simples références URL, voir le commentaire dans
  // schema.prisma sur PropertyPhoto. Accessible à tout collaborateur.
  // ---------------------------------------------------------------------

  async addPhoto(propertyId: string, dto: AddPhotoDto) {
    let position = dto.position;
    if (position === undefined) {
      const last = await this.prisma.propertyPhoto.findFirst({
        where: { propertyId },
        orderBy: { position: 'desc' },
      });
      position = (last?.position ?? -1) + 1;
    }
    return this.prisma.propertyPhoto.create({ data: { propertyId, url: dto.url, position } });
  }

  async removePhoto(propertyId: string, photoId: string) {
    const photo = await this.prisma.propertyPhoto.findUnique({ where: { id: photoId } });
    if (!photo || photo.propertyId !== propertyId) {
      throw new NotFoundException("Cette photo n'appartient pas à ce logement.");
    }
    await this.prisma.propertyPhoto.delete({ where: { id: photoId } });
  }

  // ---------------------------------------------------------------------
  // Collaborateurs — réservé au rôle MANAGER, voir
  // @RequireCollaboratorRole('MANAGER') au niveau du contrôleur.
  // ---------------------------------------------------------------------

  async inviteCollaborator(propertyId: string, dto: InviteCollaboratorDto) {
    // On n'invite jamais quelqu'un qui n'a pas déjà de compte : créer un
    // compte à la place d'un tiers reviendrait à lui assigner des droits
    // à son insu.
    const user = await this.prisma.user.findUnique({ where: { phone: dto.phone } });
    if (!user) {
      throw new NotFoundException(
        "Aucun compte SòôRooms n'est associé à ce numéro. La personne doit d'abord créer un compte.",
      );
    }

    const existing = await this.prisma.propertyCollaborator.findUnique({
      where: { userId_propertyId: { userId: user.id, propertyId } },
    });
    if (existing) {
      throw new ConflictException('Cette personne collabore déjà sur ce logement.');
    }

    return this.prisma.propertyCollaborator.create({
      data: { userId: user.id, propertyId, role: dto.role },
    });
  }

  async removeCollaborator(propertyId: string, targetUserId: string) {
    const target = await this.prisma.propertyCollaborator.findUnique({
      where: { userId_propertyId: { userId: targetUserId, propertyId } },
    });
    if (!target) {
      throw new NotFoundException("Cette personne ne collabore pas sur ce logement.");
    }

    if (target.role === 'MANAGER') {
      const managerCount = await this.prisma.propertyCollaborator.count({
        where: { propertyId, role: 'MANAGER' },
      });
      // Un établissement ne doit jamais se retrouver sans aucun MANAGER —
      // sinon plus personne ne peut inviter, publier, ou acheter un boost.
      if (managerCount <= 1) {
        throw new BadRequestException(
          'Impossible de retirer le dernier gestionnaire principal (MANAGER) de ce logement.',
        );
      }
    }

    await this.prisma.propertyCollaborator.delete({
      where: { userId_propertyId: { userId: targetUserId, propertyId } },
    });
  }

  // ---------------------------------------------------------------------
  // Publication — le verrou KYC central décidé en conception.
  // ---------------------------------------------------------------------

  async publish(propertyId: string, requesterId: string) {
    const requester = await this.prisma.user.findUnique({ where: { id: requesterId } });

    // Le contrôleur garantit déjà que l'appelant est MANAGER de CE
    // logement (RequireCollaboratorRole) — ici on vérifie les conditions
    // métier propres à la publication.
    //
    // 1) Une adresse e-mail vérifiée : un hôte doit pouvoir être joint (confirmations,
    //    litiges) et son compte récupéré. Contrôlée EN PREMIER car elle se règle en une minute,
    //    contrairement au KYC qui attend une validation par l'équipe.
    if (!requester?.emailVerifiedAt) {
      throw new ForbiddenException(
        'Vérifiez votre adresse e-mail avant de publier un logement : ouvrez « Mes informations » dans votre profil.',
      );
    }

    // 2) Son KYC doit être approuvé.
    if (requester.kycStatus !== 'APPROVED') {
      throw new ForbiddenException(
        'La publication est bloquée tant que votre vérification KYC n\'est pas approuvée.',
      );
    }

    const property = await this.prisma.property.findUnique({
      where: { id: propertyId },
      include: { _count: { select: { rooms: true } } },
    });
    if (!property) {
      throw new NotFoundException('Logement introuvable.');
    }
    // Un logement suspendu par l'équipe ne peut pas se « re-publier » seul.
    if (property.status === 'SUSPENDED') {
      throw new ForbiddenException('Ce logement a été suspendu : contactez le support SòôRooms.');
    }
    if (property._count.rooms === 0) {
      throw new BadRequestException('Ajoutez au moins une chambre avant de publier ce logement.');
    }

    const published = await this.prisma.property.update({
      where: { id: propertyId },
      data: { status: 'ACTIVE' },
      include: { amenities: true, rooms: true, photos: { orderBy: { position: 'asc' } } },
    });
    // Une seule alerte : pas de nouvelle notification si le logement était déjà publié.
    if (property.status !== 'ACTIVE') {
      await this.notifications?.notify(requesterId, 'PROPERTY_PUBLISHED', { propertyId, propertyTitle: property.title });
    }
    return published;
  }
}

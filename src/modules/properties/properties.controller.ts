import { ApiBearerAuth } from '@nestjs/swagger';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { RequireCollaboratorRole } from '../../common/decorators/require-collaborator-role.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { PropertyCollaboratorGuard } from '../../common/guards/property-collaborator.guard.js';
import type { CollaboratorRole, UserRole } from '../../prisma/client.js';
import { BookingsService } from '../bookings/bookings.service.js';
import { AddPhotoDto } from './dto/add-photo.dto.js';
import { CreatePropertyDto } from './dto/create-property.dto.js';
import { InviteCollaboratorDto } from './dto/invite-collaborator.dto.js';
import { UpdateAmenitiesDto } from './dto/update-amenities.dto.js';
import { UpdatePropertyDto } from './dto/update-property.dto.js';
import { PropertiesService } from './properties.service.js';

@Controller('properties')
@ApiBearerAuth()
export class PropertiesController {
  constructor(
    private readonly propertiesService: PropertiesService,
    private readonly bookingsService: BookingsService,
  ) {}

  // Un compte HOST peut créer un établissement (voir /auth/become-host pour la
  // bascule TRAVELER -> HOST, qui ne déclenche pas le KYC). Un ADMIN le peut
  // aussi : il peut être hôte lui-même, et sa publication reste soumise à son
  // propre KYC comme pour tout le monde.
  @Roles('HOST' as UserRole, 'ADMIN' as UserRole)
  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreatePropertyDto) {
    return this.propertiesService.create(user.id, dto);
  }

  @Get('mine')
  listMine(@CurrentUser() user: AuthenticatedUser) {
    return this.propertiesService.listMine(user.id);
  }

  @UseGuards(PropertyCollaboratorGuard)
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.propertiesService.findOne(id);
  }

  @UseGuards(PropertyCollaboratorGuard)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdatePropertyDto) {
    return this.propertiesService.update(id, dto);
  }

  @UseGuards(PropertyCollaboratorGuard)
  @Patch(':id/amenities')
  updateAmenities(@Param('id') id: string, @Body() dto: UpdateAmenitiesDto) {
    return this.propertiesService.updateAmenities(id, dto);
  }

  // Réservé au rôle MANAGER de CE logement — un AGENT ne doit pas pouvoir
  // ajouter de nouveaux collaborateurs.
  @UseGuards(PropertyCollaboratorGuard)
  @RequireCollaboratorRole('MANAGER' as CollaboratorRole)
  @Post(':id/collaborators')
  inviteCollaborator(@Param('id') id: string, @Body() dto: InviteCollaboratorDto) {
    return this.propertiesService.inviteCollaborator(id, dto);
  }

  @UseGuards(PropertyCollaboratorGuard)
  @RequireCollaboratorRole('MANAGER' as CollaboratorRole)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id/collaborators/:userId')
  async removeCollaborator(@Param('id') id: string, @Param('userId') userId: string) {
    await this.propertiesService.removeCollaborator(id, userId);
  }

  // Réservé au MANAGER : c'est lui dont le KYC doit être approuvé pour
  // débloquer la publication (voir PropertiesService.publish).
  @UseGuards(PropertyCollaboratorGuard)
  @RequireCollaboratorRole('MANAGER' as CollaboratorRole)
  @HttpCode(HttpStatus.OK)
  @Post(':id/publish')
  publish(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.propertiesService.publish(id, user.id);
  }

  // Accessible à tout collaborateur (MANAGER ou AGENT) — voir les
  // demandes de réservation et négociations en cours sur l'établissement.
  @UseGuards(PropertyCollaboratorGuard)
  @Get(':id/bookings')
  listBookings(@Param('id') id: string) {
    return this.bookingsService.findForProperty(id);
  }

  @UseGuards(PropertyCollaboratorGuard)
  @Post(':id/photos')
  addPhoto(@Param('id') id: string, @Body() dto: AddPhotoDto) {
    return this.propertiesService.addPhoto(id, dto);
  }

  @UseGuards(PropertyCollaboratorGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id/photos/:photoId')
  async removePhoto(@Param('id') id: string, @Param('photoId') photoId: string) {
    await this.propertiesService.removePhoto(id, photoId);
  }
}

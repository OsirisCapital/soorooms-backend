import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { RequirePermission } from '../../common/decorators/permissions.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import type { UserRole } from '../../prisma/client.js';
import { CreateSupportContactDto, UpdateSupportContactDto } from './dto/support-contact.dto.js';
import { SupportContactsService } from './support-contacts.service.js';

/** Visible de tous, même sans compte : un visiteur bloqué doit pouvoir joindre le support. */
@Public()
@Controller('support/contacts')
export class PublicSupportContactsController {
  constructor(private readonly contacts: SupportContactsService) {}

  @Get()
  list() {
    return this.contacts.listPublic();
  }
}

/** Réservé au super administrateur (« settings.manage »). */
@ApiBearerAuth()
@Roles('ADMIN' as UserRole)
@UseGuards(PermissionsGuard)
@RequirePermission('settings.manage')
@Controller('admin/support-contacts')
export class AdminSupportContactsController {
  constructor(private readonly contacts: SupportContactsService) {}

  @Get()
  list() {
    return this.contacts.listAll();
  }

  @HttpCode(HttpStatus.CREATED)
  @Post()
  create(@CurrentUser() actor: AuthenticatedUser, @Body() dto: CreateSupportContactDto) {
    return this.contacts.create(actor.id, dto);
  }

  @Put(':id')
  update(@CurrentUser() actor: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSupportContactDto) {
    return this.contacts.update(actor.id, id, dto);
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  async remove(@CurrentUser() actor: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.contacts.remove(actor.id, id);
  }
}

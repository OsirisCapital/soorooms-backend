import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { RequirePermission } from '../../common/decorators/permissions.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import type { UserRole } from '../../prisma/client.js';
import { UpdateFeesDto } from './dto/update-fees.dto.js';
import { FeesService } from './fees.service.js';

/** Super administrateur : voir et modifier les pourcentages. */
@ApiBearerAuth()
@Roles('ADMIN' as UserRole)
@UseGuards(PermissionsGuard)
@Controller('admin/fees')
export class AdminFeesController {
  constructor(private readonly fees: FeesService) {}

  @RequirePermission('settings.manage')
  @Get()
  view() {
    return this.fees.adminView();
  }

  @RequirePermission('settings.manage')
  @Put()
  update(@Body() dto: UpdateFeesDto, @CurrentUser() admin: AuthenticatedUser) {
    return this.fees.update(admin.id, dto);
  }
}

/** Tout utilisateur connecté : les taux en vigueur (affichés au voyageur avant de payer, à l'hôte dans ses revenus). */
@ApiBearerAuth()
@Controller('fees')
export class PublicFeesController {
  constructor(private readonly fees: FeesService) {}

  @Get('current')
  current() {
    return this.fees.publicView();
  }
}

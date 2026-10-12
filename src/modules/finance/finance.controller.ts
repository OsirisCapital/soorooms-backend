import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { RequirePermission } from '../../common/decorators/permissions.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import type { UserRole } from '../../prisma/client.js';
import { FinanceService } from './finance.service.js';

/** `days` : de 7 à 365 jours (30 par défaut). */
function parseDays(days?: string) {
  const value = days === undefined ? 30 : Number(days);
  if (!Number.isInteger(value) || value < 7 || value > 365) {
    throw new BadRequestException('days doit être un entier entre 7 et 365.');
  }
  return value;
}

/** Équipe finance : accès « payments.view » (niveaux Finance et Super administrateur). */
@ApiBearerAuth()
@Roles('ADMIN' as UserRole)
@UseGuards(PermissionsGuard)
@Controller('admin/finance')
export class AdminFinanceController {
  constructor(private readonly finance: FinanceService) {}

  @RequirePermission('payments.view')
  @Get('report')
  report(@Query('days') days?: string) {
    return this.finance.adminReport(parseDays(days));
  }
}

/** Hôte : ses propres chiffres uniquement (logements dont il est MANAGER). */
@ApiBearerAuth()
@Roles('HOST' as UserRole)
@Controller('finance')
export class HostFinanceController {
  constructor(private readonly finance: FinanceService) {}

  @Get('me')
  mine(@CurrentUser() user: AuthenticatedUser, @Query('days') days?: string) {
    return this.finance.hostReport(user.id, parseDays(days));
  }
}

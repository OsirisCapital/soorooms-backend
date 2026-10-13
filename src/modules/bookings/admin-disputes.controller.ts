import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { RequirePermission } from '../../common/decorators/permissions.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import type { UserRole } from '../../prisma/client.js';
import { DisputesService } from './disputes.service.js';
import { ResolveDisputeDto } from './dto/resolve-dispute.dto.js';

/** Espace équipe : litiges ouverts avec leurs montants, et décision (mêmes accès que les remboursements). */
@ApiBearerAuth()
@Controller('admin/disputes-queue')
@Roles('ADMIN' as UserRole)
@UseGuards(PermissionsGuard)
export class AdminDisputesController {
  constructor(private readonly disputes: DisputesService) {}

  @RequirePermission('disputes.view')
  @Get()
  list() {
    return this.disputes.list();
  }

  @RequirePermission('payouts.manage')
  @HttpCode(HttpStatus.OK)
  @Post(':id/resolve')
  resolve(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ResolveDisputeDto, @CurrentUser() user: AuthenticatedUser) {
    return this.disputes.resolve(id, user.id, dto);
  }
}

import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { RequirePermission } from '../../common/decorators/permissions.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import type { UserRole } from '../../prisma/client.js';
import { MarkPayoutPaidDto } from './dto/payout-details.dto.js';
import { RefundsService } from './refunds.service.js';

/** Espace finance : file des remboursements aux voyageurs (même permission que les versements). */
@ApiBearerAuth()
@Controller('admin/refunds')
@Roles('ADMIN' as UserRole)
@UseGuards(PermissionsGuard)
export class AdminRefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @RequirePermission('payouts.manage')
  @Get()
  list(@Query('view') view?: string) {
    return this.refunds.list(view === 'done' ? 'done' : 'open');
  }

  @RequirePermission('payouts.manage')
  @Post(':id/send')
  send(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.refunds.send(id, user.id);
  }

  @RequirePermission('payouts.manage')
  @Post(':id/mark-paid')
  markPaid(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MarkPayoutPaidDto, @CurrentUser() user: AuthenticatedUser) {
    return this.refunds.markPaidManually(id, user.id, dto.reference);
  }

  @RequirePermission('payouts.manage')
  @Post(':id/check')
  check(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.refunds.check(id, user.id);
  }
}

import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { RequirePermission } from '../../common/decorators/permissions.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import type { UserRole } from '../../prisma/client.js';
import { MarkPayoutPaidDto, SetPayoutDetailsDto } from './dto/payout-details.dto.js';
import { PayoutsService } from './payouts.service.js';

/** Espace finance : file des versements à envoyer. */
@ApiBearerAuth()
@Controller('admin/payouts')
@Roles('ADMIN' as UserRole)
@UseGuards(PermissionsGuard)
export class AdminPayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  @RequirePermission('payouts.manage')
  @Get()
  list(@Query('view') view?: string) {
    return this.payouts.list(view === 'done' ? 'done' : 'open');
  }

  @RequirePermission('payouts.manage')
  @Post(':id/send')
  send(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.payouts.send(id, user.id);
  }

  @RequirePermission('payouts.manage')
  @Post(':id/mark-paid')
  markPaid(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MarkPayoutPaidDto, @CurrentUser() user: AuthenticatedUser) {
    return this.payouts.markPaidManually(id, user.id, dto.reference);
  }

  @RequirePermission('payouts.manage')
  @Post(':id/check')
  check(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.payouts.check(id, user.id);
  }
}

/** Côté hôte : où recevoir son argent. */
@ApiBearerAuth()
@Controller('payouts/me')
export class PayoutDetailsController {
  constructor(private readonly payouts: PayoutsService) {}

  @Get()
  get(@CurrentUser() user: AuthenticatedUser) {
    return this.payouts.getDetails(user.id);
  }

  @Put()
  set(@Body() dto: SetPayoutDetailsDto, @CurrentUser() user: AuthenticatedUser) {
    return this.payouts.setDetails(user.id, dto);
  }
}

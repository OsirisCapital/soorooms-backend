import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { RequirePermission } from '../../common/decorators/permissions.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import type { UserRole } from '../../prisma/client.js';
import { MarkPayoutPaidDto, SetPayoutDetailsDto } from '../payments/dto/payout-details.dto.js';
import { ActivatePartnerDto, ClaimReferralDto, RejectPartnerPayoutDto, SuspendPartnerDto, UpdatePartnerConfigDto } from './dto/partners.dto.js';
import { PartnersAdminService } from './partners-admin.service.js';
import { PartnersService } from './partners.service.js';

/** Espace partenaire de l'utilisateur connecté. */
@ApiBearerAuth()
@Controller('partners')
export class PartnersController {
  constructor(private readonly partners: PartnersService) {}

  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.partners.me(user.id);
  }

  @Post('activate')
  activate(@Body() dto: ActivatePartnerDto, @CurrentUser() user: AuthenticatedUser) {
    return this.partners.activate(user.id, dto.acceptTerms);
  }

  @Put('me/payout-details')
  setPayoutDetails(@Body() dto: SetPayoutDetailsDto, @CurrentUser() user: AuthenticatedUser) {
    return this.partners.setPayoutDetails(user.id, dto);
  }

  @Get('me/referrals')
  referrals(@CurrentUser() user: AuthenticatedUser) {
    return this.partners.listReferrals(user.id);
  }

  @Get('me/commissions')
  commissions(@CurrentUser() user: AuthenticatedUser) {
    return this.partners.listCommissions(user.id);
  }

  @Get('me/payouts')
  payouts(@CurrentUser() user: AuthenticatedUser) {
    return this.partners.listPayouts(user.id);
  }

  @Post('me/payouts')
  requestPayout(@CurrentUser() user: AuthenticatedUser) {
    return this.partners.requestPayout(user.id);
  }

  /** Rattache le compte connecté au partenaire dont il a suivi le lien (appelée par l'application après inscription ou connexion). */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('claim')
  claim(@Body() dto: ClaimReferralDto, @CurrentUser() user: AuthenticatedUser) {
    return this.partners.claim(user.id, dto.code);
  }
}

/** Équipe : partenaires, réglages et retraits. */
@ApiBearerAuth()
@Controller('admin/partners')
@Roles('ADMIN' as UserRole)
@UseGuards(PermissionsGuard)
export class AdminPartnersController {
  constructor(private readonly admin: PartnersAdminService) {}

  @RequirePermission('partners.manage')
  @Get()
  list() {
    return this.admin.listPartners();
  }

  @RequirePermission('partners.manage')
  @Get('config')
  config() {
    return this.admin.getConfig();
  }

  @RequirePermission('partners.manage')
  @Put('config')
  updateConfig(@Body() dto: UpdatePartnerConfigDto, @CurrentUser() user: AuthenticatedUser) {
    return this.admin.updateConfig(user.id, dto);
  }

  @RequirePermission('partners.manage')
  @Get('payouts')
  payouts(@Query('view') view?: string) {
    return this.admin.listPayouts(view === 'done' ? 'done' : 'open');
  }

  @RequirePermission('partners.manage')
  @Post('payouts/:id/send')
  send(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.admin.send(id, user.id);
  }

  @RequirePermission('partners.manage')
  @Post('payouts/:id/mark-paid')
  markPaid(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MarkPayoutPaidDto, @CurrentUser() user: AuthenticatedUser) {
    return this.admin.markPaid(id, user.id, dto.reference);
  }

  @RequirePermission('partners.manage')
  @Post('payouts/:id/reject')
  reject(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectPartnerPayoutDto, @CurrentUser() user: AuthenticatedUser) {
    return this.admin.reject(id, user.id, dto.reason);
  }

  @RequirePermission('partners.manage')
  @Post('payouts/:id/check')
  check(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.admin.check(id, user.id);
  }

  @RequirePermission('partners.manage')
  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.partnerDetail(id);
  }

  @RequirePermission('partners.manage')
  @Post(':id/suspend')
  suspend(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SuspendPartnerDto, @CurrentUser() user: AuthenticatedUser) {
    return this.admin.setSuspended(id, user.id, dto.suspended, dto.reason);
  }
}

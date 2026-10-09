import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { RequirePermission } from '../../common/decorators/permissions.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import type { UserRole } from '../../prisma/client.js';
import { AssignTicketDto, CreateTicketDto, SetTicketStatusDto, StaffReplyDto, TicketReplyDto } from './dto/support.dto.js';
import { SupportService } from './support.service.js';

/** Routes de l'utilisateur : chacun ne voit que ses propres demandes. */
@ApiBearerAuth()
@Controller('support/tickets')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  // Resserré : ouvrir des demandes en rafale n'a aucun usage légitime.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateTicketDto) {
    return this.support.createTicket(user.id, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.support.listMine(user.id);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.support.getMine(user.id, id);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post(':id/messages')
  reply(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: TicketReplyDto) {
    return this.support.replyAsUser(user.id, id, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post(':id/close')
  close(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.support.closeAsUser(user.id, id);
  }
}

/** Routes de l'équipe : ADMIN avec l'accès « support.manage ». */
@ApiBearerAuth()
@Roles('ADMIN' as UserRole)
@UseGuards(PermissionsGuard)
@RequirePermission('support.manage')
@Controller('admin/support')
export class SupportAdminController {
  constructor(private readonly support: SupportService) {}

  @Get('tickets')
  list(
    @CurrentUser() staff: AuthenticatedUser,
    @Query('status') status?: string,
    @Query('scope') scope?: string,
    @Query('q') q?: string,
  ) {
    return this.support.listForStaff(staff.id, { status, scope: scope as never, q });
  }

  @Get('summary')
  summary() {
    return this.support.countToHandle();
  }

  @Get('tickets/:id')
  get(@Param('id') id: string) {
    return this.support.getForStaff(id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('tickets/:id/reply')
  reply(@CurrentUser() staff: AuthenticatedUser, @Param('id') id: string, @Body() dto: StaffReplyDto) {
    return this.support.replyAsStaff(staff.id, id, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('tickets/:id/assign')
  assign(@CurrentUser() staff: AuthenticatedUser, @Param('id') id: string, @Body() dto: AssignTicketDto) {
    return this.support.assign(staff.id, id, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('tickets/:id/status')
  setStatus(@CurrentUser() staff: AuthenticatedUser, @Param('id') id: string, @Body() dto: SetTicketStatusDto) {
    return this.support.setStatus(staff.id, id, dto);
  }
}

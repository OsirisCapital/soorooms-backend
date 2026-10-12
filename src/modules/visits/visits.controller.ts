import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { RequirePermission } from '../../common/decorators/permissions.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import type { UserRole } from '../../prisma/client.js';
import { AssignVisitDto, SubmitVisitReportDto } from './dto/visit.dto.js';
import { VisitsService } from './visits.service.js';

const STATUSES = ['PENDING_ASSIGNMENT', 'ASSIGNED', 'COMPLETED', 'REJECTED'] as const;
type ListStatus = (typeof STATUSES)[number];

/** Hôte : demander une visite pour son logement et suivre son résultat. */
@ApiBearerAuth()
@Controller('properties/:propertyId/verification')
export class HostVisitsController {
  constructor(private readonly visits: VisitsService) {}

  @Get()
  overview(@Param('propertyId', ParseUUIDPipe) propertyId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.visits.overview(propertyId, user.id);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  request(@Param('propertyId', ParseUUIDPipe) propertyId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.visits.request(propertyId, user.id);
  }
}

/** Équipe : la file des visites payées, le choix de l'agent. */
@ApiBearerAuth()
@Roles('ADMIN' as UserRole)
@UseGuards(PermissionsGuard)
@Controller('admin/visits')
export class AdminVisitsController {
  constructor(private readonly visits: VisitsService) {}

  @RequirePermission('visits.manage')
  @Get()
  list(@Query('status') status?: string) {
    const wanted = (STATUSES as readonly string[]).includes(status ?? '') ? (status as ListStatus) : undefined;
    return this.visits.list(wanted);
  }

  @RequirePermission('visits.manage')
  @Get('agents')
  agents() {
    return this.visits.agents();
  }

  @RequirePermission('visits.manage')
  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.visits.adminDetail(id);
  }

  @RequirePermission('visits.manage')
  @Post(':id/assign')
  @HttpCode(HttpStatus.OK)
  assign(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignVisitDto) {
    return this.visits.assign(id, dto.agentId);
  }
}

/** Agent de terrain : ses visites et son rapport. */
@ApiBearerAuth()
@Roles('ADMIN' as UserRole)
@UseGuards(PermissionsGuard)
@Controller('agent/visits')
export class AgentVisitsController {
  constructor(private readonly visits: VisitsService) {}

  @RequirePermission('visits.perform')
  @Get()
  mine(@CurrentUser() user: AuthenticatedUser) {
    return this.visits.mine(user.id);
  }

  @RequirePermission('visits.perform')
  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.visits.agentDetail(id, user.id);
  }

  @RequirePermission('visits.perform')
  @Post(':id/report')
  @HttpCode(HttpStatus.OK)
  submit(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SubmitVisitReportDto, @CurrentUser() user: AuthenticatedUser) {
    return this.visits.submit(id, user.id, dto);
  }
}

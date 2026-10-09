import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { RequirePermission, StaffOnly } from '../../common/decorators/permissions.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import type { UserRole } from '../../prisma/client.js';
import { AddStaffDto, AssignTaskDto, CreateTaskDto, SetTaskStatusDto, UpdateStaffDto } from './dto/staff.dto.js';
import { StaffService } from './staff.service.js';
import { TasksService } from './tasks.service.js';

/** Gestion de l'équipe : réservée aux accès « staff.manage ». */
@ApiBearerAuth()
@Roles('ADMIN' as UserRole)
@UseGuards(PermissionsGuard)
@RequirePermission('staff.manage')
@Controller('admin/staff')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get()
  list() {
    return this.staff.list();
  }

  @HttpCode(HttpStatus.CREATED)
  @Post()
  add(@CurrentUser() actor: AuthenticatedUser, @Body() dto: AddStaffDto) {
    return this.staff.add(actor.id, dto);
  }

  @Put(':id')
  update(@CurrentUser() actor: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateStaffDto) {
    return this.staff.update(actor.id, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() actor: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.staff.remove(actor.id, id);
  }
}

/** Tâches : tout membre de l'équipe a accès aux siennes ; le reste exige « staff.manage » (vérifié aussi dans le service). */
@ApiBearerAuth()
@Roles('ADMIN' as UserRole)
@UseGuards(PermissionsGuard)
@StaffOnly()
@Controller('admin/tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  list(@CurrentUser() actor: AuthenticatedUser, @Query('scope') scope?: string, @Query('filter') filter?: string) {
    return this.tasks.list(actor.id, scope === 'all' ? 'all' : 'mine', filter === 'done' ? 'done' : filter === 'all' ? 'all' : 'open');
  }

  @Get('open-count')
  openCount(@CurrentUser() actor: AuthenticatedUser) {
    return this.tasks.openCount(actor.id);
  }

  @RequirePermission('staff.manage')
  @HttpCode(HttpStatus.CREATED)
  @Post()
  create(@CurrentUser() actor: AuthenticatedUser, @Body() dto: CreateTaskDto) {
    return this.tasks.create(actor.id, dto);
  }

  @RequirePermission('staff.manage')
  @HttpCode(HttpStatus.OK)
  @Post(':id/assign')
  assign(@CurrentUser() actor: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignTaskDto) {
    return this.tasks.reassign(actor.id, id, dto.assigneeId);
  }

  @HttpCode(HttpStatus.OK)
  @Post(':id/status')
  status(@CurrentUser() actor: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetTaskStatusDto) {
    return this.tasks.setStatus(actor.id, id, dto.status);
  }

  @RequirePermission('staff.manage')
  @Delete(':id')
  remove(@CurrentUser() actor: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.tasks.remove(actor.id, id);
  }
}

import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { RequirePermission } from '../../common/decorators/permissions.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import type { UserRole } from '../../prisma/client.js';
import { AnnouncementsService } from './announcements.service.js';
import { AnnouncementDto } from './dto/announcements.dto.js';

@ApiBearerAuth()
@Roles('ADMIN' as UserRole)
@UseGuards(PermissionsGuard)
@RequirePermission('announcements.manage')
@Controller('admin/announcements')
export class AnnouncementsAdminController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Get()
  list() {
    return this.announcements.list();
  }

  @HttpCode(HttpStatus.CREATED)
  @Post()
  create(@CurrentUser() staff: AuthenticatedUser, @Body() dto: AnnouncementDto) {
    return this.announcements.create(staff.id, dto);
  }

  @Put(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AnnouncementDto) {
    return this.announcements.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.announcements.remove(id);
  }

  @HttpCode(HttpStatus.OK)
  @Post(':id/publish')
  publish(@CurrentUser() staff: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.announcements.publish(staff.id, id);
  }
}

import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { RequirePermission } from '../../common/decorators/permissions.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import type { UserRole } from '../../prisma/client.js';
import { PublishReleaseDto, SetRequiredDto } from './dto/releases.dto.js';
import { ReleasesService } from './releases.service.js';

/** Publique : l'application la lit avant même la connexion. Ne révèle que les numéros de version et les notes. */
@Controller('app')
export class AppVersionController {
  constructor(private readonly releases: ReleasesService) {}

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('version')
  current() {
    return this.releases.current();
  }
}

@ApiBearerAuth()
@Roles('ADMIN' as UserRole)
@UseGuards(PermissionsGuard)
@RequirePermission('releases.manage')
@Controller('admin/releases')
export class ReleasesAdminController {
  constructor(private readonly releases: ReleasesService) {}

  @Get()
  list() {
    return this.releases.list();
  }

  @HttpCode(HttpStatus.CREATED)
  @Post()
  publish(@CurrentUser() staff: AuthenticatedUser, @Body() dto: PublishReleaseDto) {
    return this.releases.publish(staff.id, dto);
  }

  @Patch(':id')
  setRequired(@CurrentUser() staff: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetRequiredDto) {
    return this.releases.setRequired(staff.id, id, dto.required);
  }
}

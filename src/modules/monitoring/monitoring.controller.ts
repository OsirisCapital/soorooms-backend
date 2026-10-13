import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { RequirePermission } from '../../common/decorators/permissions.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import type { UserRole } from '../../prisma/client.js';
import { MonitoringService } from './monitoring.service.js';

/**
 * Santé du service, à surveiller depuis l'extérieur (UptimeRobot, cron-job.org…) : répond 200 si l'application
 * ET la base répondent, 503 sinon. Sans jeton : un moniteur externe n'en a pas.
 */
@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly monitoring: MonitoringService) {}

  @Get()
  async check() {
    const db = await this.monitoring.databaseReachable();
    if (!db) throw new ServiceUnavailableException({ status: 'down', database: 'down' });
    return { status: 'ok', database: 'ok', uptimeSeconds: Math.round(process.uptime()), time: new Date().toISOString() };
  }
}

/** Journal des erreurs serveur : réservé à l'équipe qui a l'accès « Journal » (« audit.view »). */
@ApiBearerAuth()
@Roles('ADMIN' as UserRole)
@UseGuards(PermissionsGuard)
@RequirePermission('audit.view')
@Controller('admin/errors')
export class AdminErrorsController {
  constructor(private readonly monitoring: MonitoringService) {}

  @Get()
  list(@Query('resolved') resolved?: string) {
    return this.monitoring.list(resolved === 'true');
  }

  @HttpCode(HttpStatus.OK)
  @Post(':id/resolve')
  resolve(@Param('id', ParseUUIDPipe) id: string) {
    return this.monitoring.resolve(id);
  }
}

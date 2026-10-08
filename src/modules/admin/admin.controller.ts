import { BadRequestException, Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { RequirePermission, StaffOnly } from '../../common/decorators/permissions.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import type { UserRole } from '../../prisma/client.js';
import { AdminService } from './admin.service.js';
import { AuditService } from './audit.service.js';
import { StatsService } from './stats.service.js';

// Toutes les routes de ce contrôleur exigent le rôle ADMIN (RolesGuard lit la métadonnée posée sur la
// classe), PUIS un accès précis (PermissionsGuard) : chaque route déclare celui qu'il lui faut.
@ApiBearerAuth()
@Roles('ADMIN' as UserRole)
@UseGuards(PermissionsGuard)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly statsService: StatsService,
    private readonly auditService: AuditService,
  ) {}

  // Niveau et accès de la personne connectée.
  @StaffOnly()
  @Get('me')
  me(@CurrentUser() admin: AuthenticatedUser) {
    return this.adminService.getMyAccess(admin.id);
  }

  @RequirePermission('dashboard.view')
  @Get('stats/overview')
  statsOverview() {
    return this.statsService.overview();
  }

  // `days` : de 7 à 90 jours (30 par défaut).
  @RequirePermission('dashboard.view')
  @Get('stats/timeseries')
  statsTimeseries(@Query('days') days?: string) {
    const value = days === undefined ? 30 : Number(days);
    if (!Number.isInteger(value) || value < 7 || value > 90) {
      throw new BadRequestException('days doit être un entier entre 7 et 90.');
    }
    return this.statsService.timeseries(value);
  }

  @RequirePermission('audit.view')
  @Get('audit')
  auditLog(@Query('limit') limit?: string) {
    return this.auditService.listRecent(limit === undefined ? 100 : Number(limit));
  }

  @RequirePermission('kyc.review')
  @Get('kyc/pending')
  listPendingKyc() {
    return this.adminService.listPendingKyc();
  }

  @RequirePermission('kyc.review')
  @Get('kyc/history')
  listKycHistory(@Query('limit') limit?: string) {
    return this.adminService.listKycHistory(limit === undefined ? 50 : Number(limit));
  }

  // Lien temporaire vers un document KYC privé. `kind` : id-card ou proof-of-address.
  // Généré à la demande (et non dans la liste) pour qu'il n'ait pas expiré au moment du clic.
  @RequirePermission('kyc.review')
  @Get('kyc/documents/:documentId/:kind')
  kycDocumentLink(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('documentId') documentId: string,
    @Param('kind') kind: string,
  ) {
    return this.adminService.getKycDocumentLink(admin.id, documentId, kind);
  }

  @RequirePermission('disputes.view')
  @Get('disputes')
  listDisputes() {
    return this.adminService.listDisputes();
  }
}

import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import type { UserRole } from '../../prisma/client.js';
import { AdminService } from './admin.service.js';

// Toutes les routes de ce contrôleur exigent le rôle ADMIN (RolesGuard lit
// la métadonnée posée sur la classe).
@ApiBearerAuth()
@Roles('ADMIN' as UserRole)
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('kyc/pending')
  listPendingKyc() {
    return this.adminService.listPendingKyc();
  }

  // Lien temporaire vers un document KYC privé. `kind` : id-card ou proof-of-address.
  // Généré à la demande (et non dans la liste) pour qu'il n'ait pas expiré au moment du clic.
  @Get('kyc/documents/:documentId/:kind')
  kycDocumentLink(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('documentId') documentId: string,
    @Param('kind') kind: string,
  ) {
    return this.adminService.getKycDocumentLink(admin.id, documentId, kind);
  }

  @Get('disputes')
  listDisputes() {
    return this.adminService.listDisputes();
  }
}

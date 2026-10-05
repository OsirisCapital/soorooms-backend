import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
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

  @Get('disputes')
  listDisputes() {
    return this.adminService.listDisputes();
  }
}

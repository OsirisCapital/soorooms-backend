import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { RequirePermission } from '../../common/decorators/permissions.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import type { UserRole } from '../../prisma/client.js';
import { RejectKycDto } from './dto/reject-kyc.dto.js';
import { SubmitKycDto } from './dto/submit-kyc.dto.js';
import { KycService } from './kyc.service.js';

@ApiBearerAuth()
@Controller('kyc')
export class KycController {
  constructor(private readonly kycService: KycService) {}

  @Post('submit')
  submit(@CurrentUser() user: AuthenticatedUser, @Body() dto: SubmitKycDto) {
    return this.kycService.submit(user.id, dto);
  }

  @Get('mine')
  findMine(@CurrentUser() user: AuthenticatedUser) {
    return this.kycService.findMine(user.id);
  }

  // Décisions réservées à l'équipe ayant l'accès « kyc.review » (voir admin/permissions.ts) :
  // un administrateur du support ou de la finance ne peut pas approuver une identité.
  @Roles('ADMIN' as UserRole)
  @UseGuards(PermissionsGuard)
  @RequirePermission('kyc.review')
  @HttpCode(HttpStatus.OK)
  @Post(':userId/approve')
  approve(@CurrentUser() admin: AuthenticatedUser, @Param('userId') userId: string) {
    return this.kycService.approve(admin.id, userId);
  }

  @Roles('ADMIN' as UserRole)
  @UseGuards(PermissionsGuard)
  @RequirePermission('kyc.review')
  @HttpCode(HttpStatus.OK)
  @Post(':userId/reject')
  reject(@CurrentUser() admin: AuthenticatedUser, @Param('userId') userId: string, @Body() dto: RejectKycDto) {
    return this.kycService.reject(admin.id, userId, dto);
  }
}

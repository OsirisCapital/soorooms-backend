import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
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

  // Réservé aux administrateurs — voir SETUP.md pour promouvoir un compte
  // en ADMIN tant qu'il n'existe pas d'interface dédiée.
  @Roles('ADMIN' as UserRole)
  @HttpCode(HttpStatus.OK)
  @Post(':userId/approve')
  approve(@Param('userId') userId: string) {
    return this.kycService.approve(userId);
  }

  @Roles('ADMIN' as UserRole)
  @HttpCode(HttpStatus.OK)
  @Post(':userId/reject')
  reject(@Param('userId') userId: string, @Body() dto: RejectKycDto) {
    return this.kycService.reject(userId, dto);
  }
}

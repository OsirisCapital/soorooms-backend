import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { LoyaltyService } from './loyalty.service.js';

@ApiBearerAuth()
@Controller('loyalty')
export class LoyaltyController {
  constructor(private readonly loyalty: LoyaltyService) {}

  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.loyalty.summary(user.id);
  }
}

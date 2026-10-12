import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { PayLinkInitiateDto } from './dto/pay-link.dto.js';
import { VerifyPaymentDto } from './dto/verify-payment.dto.js';
import { PayLinksService } from './pay-links.service.js';

/** Côté voyageur (connecté) : créer / révoquer le lien de paiement d'une de ses réservations. */
@Controller('bookings/:bookingId/pay-link')
export class BookingPayLinkController {
  constructor(private readonly links: PayLinksService) {}

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post()
  create(@Param('bookingId') bookingId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.links.create(bookingId, user.id);
  }

  @ApiBearerAuth()
  @Delete()
  revoke(@Param('bookingId') bookingId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.links.revoke(bookingId, user.id);
  }
}

/** Côté payeur (sans compte) : le jeton du lien fait office d'autorisation. */
@Public()
@Controller('pay-links/:token')
export class PublicPayLinkController {
  constructor(private readonly links: PayLinksService) {}

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get()
  summary(@Param('token') token: string) {
    return this.links.summary(token);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('initiate')
  initiate(@Param('token') token: string, @Body() dto: PayLinkInitiateDto) {
    return this.links.initiate(token, dto);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('verify')
  verify(@Param('token') token: string, @Body() dto: VerifyPaymentDto) {
    return this.links.verify(token, dto.reference);
  }
}

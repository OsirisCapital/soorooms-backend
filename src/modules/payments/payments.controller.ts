import { Body, Controller, Headers, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { VerifyPaymentDto } from './dto/verify-payment.dto.js';
import { PaymentsService } from './payments.service.js';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @ApiBearerAuth()
  @Post('bookings/:bookingId/initiate')
  initiate(@Param('bookingId') bookingId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.paymentsService.initiate(bookingId, user.id);
  }

  // Appelé par la page de réservation quand le voyageur revient de la page de paiement. Complète le
  // webhook (qui peut arriver en retard ou être perdu) : le serveur relit le paiement chez l'agrégateur.
  @ApiBearerAuth()
  @Throttle({ default: { limit: 30, ttl: 60_000 } }) // la page réessaie pendant un paiement en cours
  @HttpCode(HttpStatus.OK)
  @Post('bookings/:bookingId/verify')
  verify(
    @Param('bookingId') bookingId: string,
    @Body() dto: VerifyPaymentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.paymentsService.verifyReturn(bookingId, user.id, dto.reference);
  }

  // Appelé par l'agrégateur, jamais par un utilisateur connecté — d'où
  // @Public(). La sécurité vient de la vérification de signature à
  // l'intérieur du service, pas d'un JWT.
  //
  // Notch Pay signe le corps brut (HMAC-SHA256, Hash Key) dans l'en-tête
  // x-notch-signature — voir NotchPayGateway.verifyWebhookSignature.
  @Public()
  @SkipThrottle() // appelé par l'agrégateur depuis ses propres IP : la limite par IP n'a pas de sens ici
  @HttpCode(HttpStatus.OK)
  @Post('webhook')
  webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-notch-signature') signature: string | undefined,
  ) {
    if (!req.rawBody) {
      // Ne devrait jamais arriver si rawBody: true est bien positionné
      // dans main.ts — filet de sécurité explicite plutôt qu'un crash
      // silencieux sur req.rawBody undefined.
      throw new Error('Corps brut de la requête indisponible — vérifier la configuration rawBody dans main.ts.');
    }
    return this.paymentsService.handleWebhook(req.rawBody, signature);
  }
}

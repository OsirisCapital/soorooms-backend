import { Controller, Headers, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { PaymentsService } from './payments.service.js';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @ApiBearerAuth()
  @Post('bookings/:bookingId/initiate')
  initiate(@Param('bookingId') bookingId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.paymentsService.initiate(bookingId, user.id);
  }

  // Appelé par l'agrégateur, jamais par un utilisateur connecté — d'où
  // @Public(). La sécurité vient de la vérification de signature à
  // l'intérieur du service, pas d'un JWT.
  //
  // Nom de l'en-tête de signature à CONFIRMER avec la documentation Notch
  // Pay une fois consultée — x-notchpay-signature est une supposition.
  @Public()
  @SkipThrottle() // appelé par l'agrégateur depuis ses propres IP : la limite par IP n'a pas de sens ici
  @HttpCode(HttpStatus.OK)
  @Post('webhook')
  webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-notchpay-signature') signature: string | undefined,
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

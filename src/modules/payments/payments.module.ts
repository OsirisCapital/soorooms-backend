import { Module } from '@nestjs/common';
import { NotchPayGateway } from './gateways/notchpay.gateway.js';
import { PAYMENT_GATEWAY } from './interfaces/payment-gateway.interface.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';

@Module({
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    // Bascule ici vers une autre implémentation (CinetPay, par exemple)
    // le jour venu — PaymentsService ne dépend que du jeton PAYMENT_GATEWAY,
    // jamais d'une classe concrète.
    { provide: PAYMENT_GATEWAY, useClass: NotchPayGateway },
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}

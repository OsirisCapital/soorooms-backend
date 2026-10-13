import { Module } from '@nestjs/common';
import { LoyaltyModule } from '../loyalty/loyalty.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { AttestationsController, PublicAttestationsController } from './attestations.controller.js';
import { AttestationsService } from './attestations.service.js';
import { BookingsController } from './bookings.controller.js';
import { BookingsService } from './bookings.service.js';
import { AdminDisputesController } from './admin-disputes.controller.js';
import { DisputesService } from './disputes.service.js';

@Module({
  imports: [PaymentsModule, LoyaltyModule],
  controllers: [BookingsController, AttestationsController, PublicAttestationsController, AdminDisputesController],
  providers: [BookingsService, AttestationsService, DisputesService],
  exports: [BookingsService],
})
export class BookingsModule {}

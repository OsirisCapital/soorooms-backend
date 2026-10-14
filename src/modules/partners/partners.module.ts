import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module.js';
import { PartnersAdminService } from './partners-admin.service.js';
import { AdminPartnersController, PartnersController } from './partners.controller.js';
import { PartnersService } from './partners.service.js';

@Module({
  imports: [PaymentsModule],
  controllers: [PartnersController, AdminPartnersController],
  providers: [PartnersService, PartnersAdminService],
  exports: [PartnersService],
})
export class PartnersModule {}

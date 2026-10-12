import { Module } from '@nestjs/common';
import { AdminFeesController, PublicFeesController } from './fees.controller.js';
import { FeesService } from './fees.service.js';

@Module({
  controllers: [AdminFeesController, PublicFeesController],
  providers: [FeesService],
  exports: [FeesService],
})
export class FeesModule {}

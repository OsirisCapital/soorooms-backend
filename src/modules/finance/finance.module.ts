import { Module } from '@nestjs/common';
import { AdminFinanceController, HostFinanceController } from './finance.controller.js';
import { FinanceService } from './finance.service.js';

@Module({
  controllers: [AdminFinanceController, HostFinanceController],
  providers: [FinanceService],
})
export class FinanceModule {}

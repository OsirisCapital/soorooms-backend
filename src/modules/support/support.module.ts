import { Module } from '@nestjs/common';
import { SupportAdminController, SupportController } from './support.controller.js';
import { SupportService } from './support.service.js';

@Module({
  controllers: [SupportController, SupportAdminController],
  providers: [SupportService],
})
export class SupportModule {}

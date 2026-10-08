import { Module } from '@nestjs/common';
import { UploadsController } from './uploads.controller.js';
import { UploadsService } from './uploads.service.js';

@Module({
  controllers: [UploadsController],
  providers: [UploadsService],
  // Exporté pour que l'administration puisse produire les liens temporaires des documents KYC.
  exports: [UploadsService],
})
export class UploadsModule {}

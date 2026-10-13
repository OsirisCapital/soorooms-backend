import { Global, Module } from '@nestjs/common';
import { AdminErrorsController, HealthController } from './monitoring.controller.js';
import { MonitoringService } from './monitoring.service.js';

// Global : le filtre d'erreurs (créé dans main.ts) récupère le service sans passer par un module métier.
@Global()
@Module({
  controllers: [HealthController, AdminErrorsController],
  providers: [MonitoringService],
  exports: [MonitoringService],
})
export class MonitoringModule {}

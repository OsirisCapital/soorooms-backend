import { Module } from '@nestjs/common';
import { FeesModule } from '../fees/fees.module.js';
import { AdminVisitsController, AgentVisitsController, HostVisitsController } from './visits.controller.js';
import { VisitsService } from './visits.service.js';

@Module({
  imports: [FeesModule],
  controllers: [HostVisitsController, AdminVisitsController, AgentVisitsController],
  providers: [VisitsService],
  exports: [VisitsService],
})
export class VisitsModule {}

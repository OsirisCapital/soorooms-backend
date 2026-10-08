import { Module } from '@nestjs/common';
import { UploadsModule } from '../uploads/uploads.module.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';
import { AuditService } from './audit.service.js';
import { StatsService } from './stats.service.js';

@Module({
  imports: [UploadsModule],
  controllers: [AdminController],
  providers: [AdminService, AuditService, StatsService],
})
export class AdminModule {}

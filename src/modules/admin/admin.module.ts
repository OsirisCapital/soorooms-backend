import { Module } from '@nestjs/common';
import { UploadsModule } from '../uploads/uploads.module.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';

@Module({
  imports: [UploadsModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}

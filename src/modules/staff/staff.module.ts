import { Module } from '@nestjs/common';
import { StaffController, TasksController } from './staff.controller.js';
import { StaffService } from './staff.service.js';
import { TasksService } from './tasks.service.js';

@Module({
  controllers: [StaffController, TasksController],
  providers: [StaffService, TasksService],
})
export class StaffModule {}

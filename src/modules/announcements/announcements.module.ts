import { Module } from '@nestjs/common';
import { AnnouncementsAdminController } from './announcements.controller.js';
import { AnnouncementsService } from './announcements.service.js';

@Module({
  controllers: [AnnouncementsAdminController],
  providers: [AnnouncementsService],
})
export class AnnouncementsModule {}

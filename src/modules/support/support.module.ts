import { Module } from '@nestjs/common';
import { AdminSupportContactsController, PublicSupportContactsController } from './support-contacts.controller.js';
import { SupportContactsService } from './support-contacts.service.js';
import { SupportAdminController, SupportController } from './support.controller.js';
import { SupportService } from './support.service.js';

@Module({
  controllers: [SupportController, SupportAdminController, PublicSupportContactsController, AdminSupportContactsController],
  providers: [SupportService, SupportContactsService],
})
export class SupportModule {}

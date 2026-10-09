import { Global, Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module.js';
import { NotificationEmailService } from './notification-email.service.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';

// Global : tout module métier (réservations, paiements, KYC…) peut notifier sans importer celui-ci.
@Global()
@Module({
  imports: [MailModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationEmailService],
  exports: [NotificationsService],
})
export class NotificationsModule {}

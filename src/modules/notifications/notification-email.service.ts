/**
 * Envoie par e-mail certaines notifications. Même principe que la cloche : un e-mail est un effet
 * secondaire, jamais une condition. `sendFor` ne lève JAMAIS d'erreur et n'est pas attendu par
 * l'appelant : un paiement ou une réservation ne dépend pas d'un fournisseur d'e-mails.
 *
 * On n'écrit qu'aux adresses VÉRIFIÉES (une adresse non prouvée peut appartenir à quelqu'un d'autre)
 * et seulement si la personne n'a pas désactivé les e-mails.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { MailService } from '../mail/mail.service.js';
import { notificationEmail } from '../mail/notification-email.template.js';
import { isInternalPath, type NotificationType, type RenderedNotification } from './notification-types.js';

/**
 * Événements qui méritent un e-mail : ceux où la personne doit agir ou veut savoir tout de suite.
 * Les alertes internes de l'équipe, les annonces et les tâches restent dans l'application.
 */
export const EMAIL_NOTIFICATION_TYPES: ReadonlySet<NotificationType> = new Set<NotificationType>([
  'KYC_APPROVED',
  'KYC_REJECTED',
  'BOOKING_REQUESTED',
  'OFFER_RECEIVED',
  'OFFER_ACCEPTED',
  'OFFER_REJECTED',
  'PAYMENT_CONFIRMED',
  'PAYMENT_FAILED',
  'STAY_CONFIRMATION_REQUESTED',
  'BOOKING_COMPLETED',
  'PAYOUT_RELEASED',
  'DISPUTE_OPENED',
  'PROPERTY_PUBLISHED',
  'PROPERTY_SUSPENDED',
  'SUPPORT_REPLY',
  'SUPPORT_TICKET_RESOLVED',
  'STAFF_ACCESS_CHANGED',
  'MESSAGE_RECEIVED',
]);

@Injectable()
export class NotificationEmailService {
  private readonly logger = new Logger(NotificationEmailService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async sendFor(userIds: string[], type: NotificationType, rendered: RenderedNotification): Promise<void> {
    if (!EMAIL_NOTIFICATION_TYPES.has(type) || userIds.length === 0) return;
    try {
      const recipients = await this.prisma.user.findMany({
        where: { id: { in: userIds }, email: { not: null }, emailVerifiedAt: { not: null }, emailNotifications: true },
        select: { email: true, fullName: true },
      });
      const base = this.config.get('frontendUrl', { infer: true });
      const path = isInternalPath(rendered.linkUrl) ? rendered.linkUrl : '/notifications';

      await Promise.all(
        recipients.map(async (user) => {
          if (!user.email) return;
          const content = notificationEmail({
            fullName: user.fullName,
            title: rendered.title,
            body: rendered.body,
            url: `${base}${path}`,
            settingsUrl: `${base}/notifications`,
          });
          await this.mail.send({ to: { email: user.email, name: user.fullName }, ...content });
        }),
      );
    } catch (error) {
      this.logger.error(`E-mail ${type} non envoyé : ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * Envoie par WhatsApp certaines notifications. Même principe que l'e-mail : un effet secondaire, jamais
 * une condition. `sendFor` ne lève JAMAIS d'erreur et n'est pas attendu par l'appelant.
 *
 * Seulement aux vrais numéros (pas les « google:<id> »), et seulement si la personne n'a pas désactivé WhatsApp.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { isInternalPath, type NotificationType, type RenderedNotification } from './notification-types.js';
import { toWhatsappNumber, WhatsAppService } from './whatsapp.service.js';

/** Événements qui méritent un message : ceux où la personne doit agir ou veut savoir tout de suite. */
export const WHATSAPP_NOTIFICATION_TYPES: ReadonlySet<NotificationType> = new Set<NotificationType>([
  // Réservation et paiement
  'BOOKING_REQUESTED',
  'OFFER_RECEIVED',
  'OFFER_ACCEPTED',
  'OFFER_REJECTED',
  'BOOKING_EXPIRED',
  'PAYMENT_CONFIRMED',
  'PAYMENT_FAILED',
  'BALANCE_FORFEITED',
  // Annulation et remboursement
  'BOOKING_CANCELLED',
  'REFUND_SENT',
  // Versement hôte et litige
  'PAYOUT_RELEASED',
  'DISPUTE_OPENED',
  'DISPUTE_RESOLVED',
  // Rappel d'arrivée
  'ARRIVAL_REMINDER',
]);

@Injectable()
export class NotificationWhatsappService {
  private readonly logger = new Logger(NotificationWhatsappService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsAppService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async sendFor(userIds: string[], type: NotificationType, rendered: RenderedNotification): Promise<void> {
    if (!WHATSAPP_NOTIFICATION_TYPES.has(type) || userIds.length === 0 || !this.whatsapp.enabled) return;
    try {
      const recipients = await this.prisma.user.findMany({
        where: { id: { in: userIds }, whatsappNotifications: true },
        select: { phone: true, fullName: true },
      });
      const base = this.config.get('frontendUrl', { infer: true });
      const path = isInternalPath(rendered.linkUrl) ? rendered.linkUrl : '/notifications';
      await Promise.all(
        recipients.map(async (user) => {
          const to = toWhatsappNumber(user.phone);
          if (!to) return;
          await this.whatsapp.send({
            to,
            firstName: user.fullName.trim().split(/\s+/)[0] ?? '',
            message: `${rendered.title} — ${rendered.body}`,
            url: `${base}${path}`,
          });
        }),
      );
    } catch (error) {
      this.logger.error(`WhatsApp ${type} non envoyé : ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

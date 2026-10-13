/**
 * Envoie le rappel d'arrivée (cloche, e-mail, WhatsApp) au voyageur et aux gérants du logement.
 * Déclenché par une tâche planifiée EXTERNE (voir ArrivalRemindersController) : le serveur peut dormir
 * entre deux appels, donc rien ne repose sur un minuteur interne.
 *
 * Un seul rappel par réservation : on « réclame » la réservation de façon atomique avant d'écrire,
 * si deux appels se chevauchent, un seul envoie.
 */
import { Injectable, Logger } from '@nestjs/common';
import { can } from '../../common/utils/collaborator-access.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { arrivalLabel, isReminderDue } from './arrival-reminders.js';
import type { RefundKind } from './refund-policy.js';

const DAY_MS = 86_400_000;

@Injectable()
export class ArrivalRemindersService {
  private readonly logger = new Logger(ArrivalRemindersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Renvoie le nombre de réservations rappelées. */
  async run(now = new Date()): Promise<{ reminded: number }> {
    const candidates = await this.prisma.booking.findMany({
      where: {
        status: { in: ['DEPOSIT_PAID', 'CONFIRMED_ESCROW'] },
        arrivalReminderSentAt: null,
        // Large (fuseau, sieste) : le calcul exact se fait ensuite sur l'instant d'arrivée.
        checkInDate: { gte: new Date(now.getTime() - DAY_MS), lte: new Date(now.getTime() + 2 * DAY_MS) },
      },
      select: {
        id: true,
        travelerId: true,
        checkInDate: true,
        napStartHour: true,
        traveler: { select: { fullName: true } },
        room: { select: { property: { select: { title: true, propertyType: true, collaborators: { select: { userId: true, role: true } } } } } },
      },
      take: 200,
    });

    let reminded = 0;
    for (const b of candidates) {
      const type = b.room.property.propertyType;
      const kind: RefundKind = b.napStartHour != null ? 'NAP' : type === 'EVENT_HALL' ? 'HALL' : type === 'STUDENT_RESIDENCE' ? 'RESIDENCE' : 'NIGHT';
      if (!isReminderDue(kind, b.checkInDate, b.napStartHour, now)) continue;
      try {
        const claimed = await this.prisma.booking.updateMany({ where: { id: b.id, arrivalReminderSentAt: null }, data: { arrivalReminderSentAt: now } });
        if (claimed.count === 0) continue;
        const when = arrivalLabel(kind, b.checkInDate, b.napStartHour, now);
        const title = b.room.property.title;
        await this.notifications.notify(b.travelerId, 'ARRIVAL_REMINDER', { bookingId: b.id, audience: 'traveler', propertyTitle: title, when });
        for (const c of b.room.property.collaborators.filter((x) => can(x.role, 'bookings.manage'))) {
          await this.notifications.notify(c.userId, 'ARRIVAL_REMINDER', { bookingId: b.id, audience: 'host', propertyTitle: title, when, otherName: b.traveler.fullName });
        }
        reminded += 1;
      } catch (error) {
        this.logger.error(`Rappel d'arrivée non envoyé pour ${b.id} : ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { reminded };
  }
}

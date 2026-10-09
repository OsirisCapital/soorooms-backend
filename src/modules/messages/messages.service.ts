/**
 * Messagerie entre le voyageur et l'équipe d'hôtes d'un logement. Une conversation = une réservation :
 * c'est elle qui dit QUI a le droit d'écrire (le voyageur, et les gestionnaires du logement).
 *
 * Règles de sécurité :
 *  - seuls les participants de la réservation lisent et écrivent ; pour tout autre, la conversation
 *    « n'existe pas » (404, pas 403 : on ne révèle pas qu'une réservation existe) ;
 *  - l'équipe SòôRooms n'a aucun accès à ces messages ;
 *  - l'identité de l'auteur vient du jeton, jamais de la requête ; on ne renvoie ni e-mail ni téléphone ;
 *  - une notification n'est jamais une condition de l'envoi (voir NotificationsService).
 */
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';

/** Une conversation ne grandit pas sans limite. */
export const MAX_MESSAGES_PER_CONVERSATION = 500;
/** Nombre de messages renvoyés à l'ouverture d'une conversation. */
export const PAGE_SIZE = 100;
/** Rafale d'un même auteur : une seule notification dans cet intervalle. */
export const NOTIFY_QUIET_MS = 10 * 60_000;
const LIST_LIMIT = 50;

const participantInclude = {
  traveler: { select: { id: true, fullName: true } },
  room: { select: { property: { select: { title: true, collaborators: { select: { userId: true, role: true, user: { select: { fullName: true } } } } } } } },
} as const;

type Side = 'traveler' | 'host';

@Injectable()
export class MessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Charge la réservation et vérifie que `userId` y participe. */
  private async participant(userId: string, bookingId: string) {
    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId }, include: participantInclude });
    if (!booking) throw new NotFoundException('Conversation introuvable.');
    const collaborators = booking.room.property.collaborators;
    const side: Side | null = booking.traveler.id === userId ? 'traveler' : collaborators.some((c) => c.userId === userId) ? 'host' : null;
    if (!side) throw new NotFoundException('Conversation introuvable.');
    const manager = collaborators.find((c) => c.role === 'MANAGER') ?? collaborators[0];
    return { booking, side, collaborators, manager };
  }

  private counterpartName(side: Side, travelerName: string, managerName: string | undefined) {
    return side === 'traveler' ? (managerName ?? 'Hôte') : travelerName;
  }

  /** Mes conversations (celles qui contiennent au moins un message), la plus récente d'abord. */
  async listConversations(userId: string) {
    const bookings = await this.prisma.booking.findMany({
      where: {
        messages: { some: {} },
        OR: [{ travelerId: userId }, { room: { property: { collaborators: { some: { userId } } } } }],
      },
      include: {
        ...participantInclude,
        messages: { orderBy: { sentAt: 'desc' }, take: 1, select: { content: true, sentAt: true, senderId: true } },
        conversationReads: { where: { userId }, select: { lastReadAt: true } },
      },
      take: 200,
    });
    const unread = await this.unreadByBooking(
      userId,
      bookings.map((b) => ({ id: b.id, lastReadAt: b.conversationReads[0]?.lastReadAt ?? null })),
    );
    return bookings
      .map((b) => {
        const side: Side = b.traveler.id === userId ? 'traveler' : 'host';
        const collaborators = b.room.property.collaborators;
        const manager = collaborators.find((c) => c.role === 'MANAGER') ?? collaborators[0];
        const last = b.messages[0];
        return {
          bookingId: b.id,
          propertyTitle: b.room.property.title,
          bookingStatus: b.status,
          counterpart: this.counterpartName(side, b.traveler.fullName, manager?.user.fullName),
          lastMessage: { preview: last.content.slice(0, 120), sentAt: last.sentAt, mine: last.senderId === userId },
          unread: unread.get(b.id) ?? 0,
        };
      })
      .sort((a, b) => b.lastMessage.sentAt.getTime() - a.lastMessage.sentAt.getTime())
      .slice(0, LIST_LIMIT);
  }

  /** Nombre de messages non lus par conversation (messages d'autrui plus récents que ma dernière lecture). */
  private async unreadByBooking(userId: string, reads: Array<{ id: string; lastReadAt: Date | null }>) {
    const counts = new Map<string, number>();
    if (reads.length === 0) return counts;
    const lastRead = new Map(reads.map((r) => [r.id, r.lastReadAt]));
    const rows = await this.prisma.message.findMany({
      where: { bookingId: { in: reads.map((r) => r.id) }, senderId: { not: userId } },
      select: { bookingId: true, sentAt: true },
      orderBy: { sentAt: 'desc' },
      take: 2000,
    });
    for (const row of rows) {
      if (!row.bookingId) continue;
      const seen = lastRead.get(row.bookingId);
      if (!seen || row.sentAt > seen) counts.set(row.bookingId, (counts.get(row.bookingId) ?? 0) + 1);
    }
    return counts;
  }

  /** Pastille de l'en-tête : nombre de conversations avec au moins un message non lu. */
  async unreadConversations(userId: string) {
    const bookings = await this.prisma.booking.findMany({
      where: {
        messages: { some: { senderId: { not: userId } } },
        OR: [{ travelerId: userId }, { room: { property: { collaborators: { some: { userId } } } } }],
      },
      select: { id: true, conversationReads: { where: { userId }, select: { lastReadAt: true } } },
      take: 200,
    });
    const unread = await this.unreadByBooking(
      userId,
      bookings.map((b) => ({ id: b.id, lastReadAt: b.conversationReads[0]?.lastReadAt ?? null })),
    );
    return { count: unread.size };
  }

  /** Ouvre une conversation : renvoie les derniers messages et la marque comme lue. */
  async getConversation(userId: string, bookingId: string) {
    const { booking, side, manager } = await this.participant(userId, bookingId);
    const rows = await this.prisma.message.findMany({
      where: { bookingId },
      orderBy: { sentAt: 'desc' },
      take: PAGE_SIZE,
      select: { id: true, senderId: true, content: true, sentAt: true, sender: { select: { fullName: true } } },
    });
    await this.markRead(userId, bookingId);
    return {
      bookingId,
      propertyTitle: booking.room.property.title,
      bookingStatus: booking.status,
      counterpart: this.counterpartName(side, booking.traveler.fullName, manager?.user.fullName),
      messages: rows.reverse().map((m) => ({
        id: m.id,
        mine: m.senderId === userId,
        author: m.senderId === userId ? 'Vous' : m.sender.fullName,
        content: m.content,
        sentAt: m.sentAt,
      })),
    };
  }

  private markRead(userId: string, bookingId: string) {
    const now = new Date();
    return this.prisma.conversationRead.upsert({
      where: { userId_bookingId: { userId, bookingId } },
      create: { userId, bookingId, lastReadAt: now },
      update: { lastReadAt: now },
    });
  }

  async send(userId: string, bookingId: string, content: string) {
    const { booking, side, collaborators, manager } = await this.participant(userId, bookingId);
    const sender = await this.prisma.user.findUnique({ where: { id: userId }, select: { fullName: true } });

    const total = await this.prisma.message.count({ where: { bookingId } });
    if (total >= MAX_MESSAGES_PER_CONVERSATION) {
      throw new ForbiddenException('Cette conversation a atteint sa limite de messages.');
    }
    const previous = await this.prisma.message.findFirst({ where: { bookingId }, orderBy: { sentAt: 'desc' }, select: { senderId: true, sentAt: true } });

    // receiverId reste renseigné (colonne historique) : l'interlocuteur principal de l'autre camp.
    const receiverId = side === 'traveler' ? (manager?.userId ?? userId) : booking.traveler.id;
    const message = await this.prisma.message.create({
      data: { senderId: userId, receiverId, bookingId, content },
      select: { id: true, content: true, sentAt: true },
    });
    await this.markRead(userId, bookingId);

    // Pas de notification en rafale : un même auteur qui enchaîne les messages n'en déclenche qu'une.
    const burst = previous && previous.senderId === userId && message.sentAt.getTime() - previous.sentAt.getTime() < NOTIFY_QUIET_MS;
    if (!burst) {
      const recipients = side === 'traveler' ? collaborators.map((c) => c.userId).filter((id) => id !== userId) : [booking.traveler.id];
      await this.notifications.notifyMany(recipients, 'MESSAGE_RECEIVED', { fromName: sender?.fullName ?? 'Quelqu’un', bookingId });
    }
    return { id: message.id, mine: true, author: 'Vous', content: message.content, sentAt: message.sentAt };
  }
}

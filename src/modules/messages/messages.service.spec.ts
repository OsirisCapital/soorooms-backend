import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import { MAX_MESSAGES_PER_CONVERSATION, MessagesService, NOTIFY_QUIET_MS } from './messages.service.js';

const BOOKING = {
  id: 'b1',
  status: 'CONFIRMED_ESCROW',
  traveler: { id: 'trav', fullName: 'Marie Ngo' },
  room: {
    property: {
      title: 'Villa Kribi',
      collaborators: [
        { userId: 'mgr', role: 'MANAGER', user: { fullName: 'Paul Hôte' } },
        { userId: 'agent', role: 'AGENT', user: { fullName: 'Aïcha Agent' } },
      ],
    },
  },
};

function make(over: { booking?: unknown; total?: number; previous?: unknown } = {}) {
  const sentAt = new Date();
  const prisma = {
    booking: { findUnique: vi.fn().mockResolvedValue(over.booking === undefined ? BOOKING : over.booking), findMany: vi.fn().mockResolvedValue([]) },
    message: {
      count: vi.fn().mockResolvedValue(over.total ?? 3),
      findFirst: vi.fn().mockResolvedValue(over.previous === undefined ? null : over.previous),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: 'm1', content: 'Bonjour', sentAt }),
    },
    conversationRead: { upsert: vi.fn().mockResolvedValue({}) },
    user: { findUnique: vi.fn().mockResolvedValue({ fullName: 'Marie Ngo' }) },
  };
  const notifications = { notifyMany: vi.fn().mockResolvedValue(undefined) };
  const service = new MessagesService(prisma as unknown as PrismaService, notifications as unknown as NotificationsService);
  return { service, prisma, notifications, sentAt };
}

describe('MessagesService — accès', () => {
  it('un étranger à la réservation ne peut ni lire ni écrire (404, sans révéler que la réservation existe)', async () => {
    const { service, prisma } = make();
    await expect(service.getConversation('intrus', 'b1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.send('intrus', 'b1', 'Salut')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.message.create).not.toHaveBeenCalled();
    expect(prisma.conversationRead.upsert).not.toHaveBeenCalled();
  });

  it('une réservation inexistante donne le même 404', async () => {
    const { service } = make({ booking: null });
    await expect(service.getConversation('trav', 'b1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('MessagesService — envoi', () => {
  it('le voyageur écrit : l’auteur vient du jeton, le message va à l’hôte principal, tous les gestionnaires sont prévenus', async () => {
    const { service, prisma, notifications } = make();
    const out = await service.send('trav', 'b1', 'Bonjour');
    expect(prisma.message.create).toHaveBeenCalledWith(expect.objectContaining({ data: { senderId: 'trav', receiverId: 'mgr', bookingId: 'b1', content: 'Bonjour' } }));
    expect(notifications.notifyMany).toHaveBeenCalledWith(['mgr', 'agent'], 'MESSAGE_RECEIVED', { fromName: 'Marie Ngo', bookingId: 'b1' });
    expect(out).toMatchObject({ mine: true, author: 'Vous', content: 'Bonjour' });
  });

  it('un gestionnaire écrit : le voyageur est prévenu, pas ses collègues', async () => {
    const { service, prisma, notifications } = make();
    await service.send('agent', 'b1', 'Bienvenue');
    expect(prisma.message.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ receiverId: 'trav' }) }));
    expect(notifications.notifyMany).toHaveBeenCalledWith(['trav'], 'MESSAGE_RECEIVED', expect.anything());
  });

  it('marque la conversation lue pour l’auteur', async () => {
    const { service, prisma } = make();
    await service.send('trav', 'b1', 'Bonjour');
    expect(prisma.conversationRead.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { userId_bookingId: { userId: 'trav', bookingId: 'b1' } } }));
  });

  it('une rafale du même auteur ne déclenche qu’une notification', async () => {
    const recent = { senderId: 'trav', sentAt: new Date(Date.now() - 60_000) };
    const { service, notifications } = make({ previous: recent });
    await service.send('trav', 'b1', 'Et aussi…');
    expect(notifications.notifyMany).not.toHaveBeenCalled();
  });

  it('après une pause, ou après une réponse de l’autre camp, on notifie de nouveau', async () => {
    const old = make({ previous: { senderId: 'trav', sentAt: new Date(Date.now() - NOTIFY_QUIET_MS - 1000) } });
    await old.service.send('trav', 'b1', 'Toujours là ?');
    expect(old.notifications.notifyMany).toHaveBeenCalledTimes(1);
    const reply = make({ previous: { senderId: 'mgr', sentAt: new Date(Date.now() - 1000) } });
    await reply.service.send('trav', 'b1', 'Merci');
    expect(reply.notifications.notifyMany).toHaveBeenCalledTimes(1);
  });

  it('refuse au-delà de la limite de la conversation', async () => {
    const { service, prisma } = make({ total: MAX_MESSAGES_PER_CONVERSATION });
    await expect(service.send('trav', 'b1', 'Encore')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.message.create).not.toHaveBeenCalled();
  });
});

describe('MessagesService — lecture', () => {
  it('renvoie la conversation dans l’ordre, sans coordonnées, et la marque lue', async () => {
    const { service, prisma } = make();
    prisma.message.findMany.mockResolvedValue([
      { id: 'm2', senderId: 'mgr', content: 'Avec plaisir', sentAt: new Date('2026-10-09T10:05:00Z'), sender: { fullName: 'Paul Hôte' } },
      { id: 'm1', senderId: 'trav', content: 'Bonjour', sentAt: new Date('2026-10-09T10:00:00Z'), sender: { fullName: 'Marie Ngo' } },
    ]);
    const out = await service.getConversation('trav', 'b1');
    expect(out.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(out.messages[0]).toMatchObject({ mine: true, author: 'Vous' });
    expect(out.messages[1]).toMatchObject({ mine: false, author: 'Paul Hôte' });
    expect(out.counterpart).toBe('Paul Hôte');
    expect(JSON.stringify(out)).not.toMatch(/email|phone/i);
    expect(prisma.conversationRead.upsert).toHaveBeenCalledTimes(1);
  });

  it('côté hôte, l’interlocuteur affiché est le voyageur', async () => {
    const { service } = make();
    expect((await service.getConversation('agent', 'b1')).counterpart).toBe('Marie Ngo');
  });

  it('compte les messages d’autrui plus récents que la dernière lecture', async () => {
    const { service, prisma } = make();
    prisma.booking.findMany.mockResolvedValue([
      { id: 'b1', conversationReads: [{ lastReadAt: new Date('2026-10-09T10:00:00Z') }] },
      { id: 'b2', conversationReads: [] },
      { id: 'b3', conversationReads: [{ lastReadAt: new Date('2026-10-09T12:00:00Z') }] },
    ]);
    prisma.message.findMany.mockResolvedValue([
      { bookingId: 'b1', sentAt: new Date('2026-10-09T11:00:00Z') }, // non lu
      { bookingId: 'b1', sentAt: new Date('2026-10-09T09:00:00Z') }, // déjà lu
      { bookingId: 'b2', sentAt: new Date('2026-10-01T09:00:00Z') }, // jamais ouverte : non lu
      { bookingId: 'b3', sentAt: new Date('2026-10-09T11:00:00Z') }, // lu
    ]);
    expect(await service.unreadConversations('trav')).toEqual({ count: 2 });
    // Seuls les messages des AUTRES comptent : les siens ne sont jamais « non lus ».
    expect(prisma.message.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ senderId: { not: 'trav' } }) }));
  });

  it('la liste ne porte que sur mes réservations', async () => {
    const { service, prisma } = make();
    await service.listConversations('trav');
    const where = prisma.booking.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([{ travelerId: 'trav' }, { room: { property: { collaborators: { some: { userId: 'trav' } } } } }]);
  });
});

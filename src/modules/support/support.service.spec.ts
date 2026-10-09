import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { PERMISSIONS_KEY } from '../../common/decorators/permissions.decorator.js';
import { ROLES_KEY } from '../../common/decorators/roles.decorator.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import { MAX_ACTIVE_TICKETS_PER_USER, MAX_MESSAGES_PER_TICKET, SupportService } from './support.service.js';
import { SupportAdminController, SupportController } from './support.controller.js';

const SUPPORT = { role: 'ADMIN', staffRole: 'SUPPORT', staffPermissions: [] };
const SUPER = { role: 'ADMIN', staffRole: null, staffPermissions: [] };
const FINANCE = { role: 'ADMIN', staffRole: 'FINANCE', staffPermissions: [] };

function make(over: { ticket?: Record<string, unknown> | null; active?: number; users?: Record<string, unknown> } = {}) {
  const ticketRow = over.ticket === undefined ? { id: 't1', number: 42, userId: 'u1', status: 'OPEN', assigneeId: null, _count: { messages: 1 } } : over.ticket;
  const tx = {
    supportTicket: { create: vi.fn().mockResolvedValue({ id: 't1', number: 42, subject: 'Aide', category: 'OTHER', status: 'OPEN', createdAt: new Date() }), update: vi.fn() },
    ticketMessage: { create: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  const prisma = {
    supportTicket: {
      count: vi.fn().mockResolvedValue(over.active ?? 0),
      findFirst: vi.fn().mockResolvedValue(ticketRow),
      findUnique: vi.fn().mockResolvedValue(ticketRow),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    booking: { findUnique: vi.fn().mockResolvedValue(null) },
    user: {
      findUnique: vi.fn().mockImplementation(async ({ where }: { where: { id: string } }) => over.users?.[where.id] ?? { fullName: 'Marie Ngo', ...SUPPORT }),
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const notifications = { notify: vi.fn().mockResolvedValue(true), notifyStaff: vi.fn().mockResolvedValue(undefined) };
  const service = new SupportService(prisma as unknown as PrismaService, notifications as unknown as NotificationsService);
  return { service, prisma, tx, notifications };
}

describe('SupportService — création', () => {
  const dto = { subject: 'Problème de paiement', category: 'PAYMENT', message: 'Mon paiement ne passe pas.' } as never;

  it("crée la demande et son premier message ensemble, puis prévient l'équipe support (pas l'auteur)", async () => {
    const { service, tx, notifications } = make();
    await service.createTicket('u1', dto);
    expect(tx.supportTicket.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId: 'u1', category: 'PAYMENT' }) }));
    expect(tx.ticketMessage.create).toHaveBeenCalledWith({ data: { ticketId: 't1', authorId: 'u1', isStaff: false, body: 'Mon paiement ne passe pas.' } });
    expect(notifications.notifyStaff).toHaveBeenCalledWith('support.manage', 'SUPPORT_TICKET_NEW', { ticketId: 't1', number: 42, subject: 'Aide' }, 'u1');
  });

  it(`refuse au-delà de ${MAX_ACTIVE_TICKETS_PER_USER} demandes en cours, sans rien créer`, async () => {
    const { service, prisma, notifications } = make({ active: MAX_ACTIVE_TICKETS_PER_USER });
    await expect(service.createTicket('u1', dto)).rejects.toThrow(ConflictException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(notifications.notifyStaff).not.toHaveBeenCalled();
  });

  it("refuse de lier une réservation qui n'est pas à l'utilisateur (même message qu'une réservation inconnue)", async () => {
    const { service, prisma } = make();
    prisma.booking.findUnique.mockResolvedValue({ travelerId: 'autre', room: { property: { collaborators: [{ userId: 'host' }] } } });
    await expect(service.createTicket('u1', { ...(dto as object), bookingId: 'b1' } as never)).rejects.toThrow(NotFoundException);
    prisma.booking.findUnique.mockResolvedValue(null);
    await expect(service.createTicket('u1', { ...(dto as object), bookingId: 'b1' } as never)).rejects.toThrow(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('accepte la réservation du voyageur ou celle du logement géré', async () => {
    const { service, prisma } = make();
    prisma.booking.findUnique.mockResolvedValue({ travelerId: 'u1', room: { property: { collaborators: [] } } });
    await expect(service.createTicket('u1', { ...(dto as object), bookingId: 'b1' } as never)).resolves.toBeTruthy();
    prisma.booking.findUnique.mockResolvedValue({ travelerId: 'autre', room: { property: { collaborators: [{ userId: 'u1' }] } } });
    await expect(service.createTicket('u1', { ...(dto as object), bookingId: 'b1' } as never)).resolves.toBeTruthy();
  });
});

describe('SupportService — côté utilisateur', () => {
  it("ne lit que SES demandes et n'envoie jamais les notes internes", async () => {
    const { service, prisma } = make({ ticket: { id: 't1' } });
    await service.getMine('u1', 't1');
    const args = prisma.supportTicket.findFirst.mock.calls[0][0];
    expect(args.where).toEqual({ id: 't1', userId: 'u1' });
    expect(args.select.messages.where).toEqual({ internal: false });
    expect(JSON.stringify(args.select)).not.toContain('"author"');
  });

  it("répond 404 pour la demande d'un autre", async () => {
    const { service } = make({ ticket: null });
    await expect(service.getMine('u1', 'xx')).rejects.toThrow(NotFoundException);
    await expect(service.replyAsUser('u1', 'xx', { body: 'bonjour' })).rejects.toThrow(NotFoundException);
  });

  it('liste uniquement ses propres demandes', async () => {
    const { service, prisma } = make();
    await service.listMine('u1');
    expect(prisma.supportTicket.findMany.mock.calls[0][0].where).toEqual({ userId: 'u1' });
  });

  it("une réponse rouvre une demande en attente ou résolue, mais ne change pas une demande « en cours »", async () => {
    for (const [from, to] of [['WAITING_USER', 'OPEN'], ['RESOLVED', 'OPEN'], ['IN_PROGRESS', 'IN_PROGRESS'], ['OPEN', 'OPEN']] as const) {
      const { service, tx } = make({ ticket: { id: 't1', number: 42, status: from, assigneeId: null, _count: { messages: 2 } } });
      await service.replyAsUser('u1', 't1', { body: 'Merci' });
      expect(tx.supportTicket.update.mock.calls[0][0].data.status, `${from}`).toBe(to);
    }
  });

  it("prévient la personne assignée, ou à défaut toute l'équipe support", async () => {
    const assigned = make({ ticket: { id: 't1', number: 42, status: 'WAITING_USER', assigneeId: 'agent-1', _count: { messages: 2 } } });
    await assigned.service.replyAsUser('u1', 't1', { body: 'Merci' });
    expect(assigned.notifications.notify).toHaveBeenCalledWith('agent-1', 'SUPPORT_USER_REPLY', expect.objectContaining({ ticketId: 't1', number: 42 }));
    expect(assigned.notifications.notifyStaff).not.toHaveBeenCalled();

    const free = make({ ticket: { id: 't1', number: 42, status: 'OPEN', assigneeId: null, _count: { messages: 2 } } });
    await free.service.replyAsUser('u1', 't1', { body: 'Merci' });
    expect(free.notifications.notifyStaff).toHaveBeenCalledWith('support.manage', 'SUPPORT_USER_REPLY', expect.anything(), 'u1');
  });

  it(`refuse de répondre à une demande clôturée ou trop longue (${MAX_MESSAGES_PER_TICKET} messages)`, async () => {
    const closed = make({ ticket: { id: 't1', number: 1, status: 'CLOSED', assigneeId: null, _count: { messages: 2 } } });
    await expect(closed.service.replyAsUser('u1', 't1', { body: 'Allô' })).rejects.toThrow(ConflictException);
    expect(closed.tx.ticketMessage.create).not.toHaveBeenCalled();
    const long = make({ ticket: { id: 't1', number: 1, status: 'OPEN', assigneeId: null, _count: { messages: MAX_MESSAGES_PER_TICKET } } });
    await expect(long.service.replyAsUser('u1', 't1', { body: 'Allô' })).rejects.toThrow(ConflictException);
  });

  it("clôturer ne touche que SA demande", async () => {
    const { service, prisma } = make({ ticket: { id: 't1' } });
    await service.closeAsUser('u1', 't1');
    expect(prisma.supportTicket.updateMany.mock.calls[0][0].where).toEqual({ id: 't1', userId: 'u1', status: { not: 'CLOSED' } });
  });
});

describe('SupportService — réponse de l\'équipe', () => {
  const base = { id: 't1', number: 42, userId: 'u1', status: 'OPEN', assigneeId: null, _count: { messages: 3 } };

  it("une réponse publique passe la demande « en attente de l'utilisateur », prend la demande et prévient l'utilisateur", async () => {
    const { service, tx, notifications } = make({ ticket: base });
    await service.replyAsStaff('agent-1', 't1', { body: 'Bonjour, voici la solution.' });
    expect(tx.ticketMessage.create).toHaveBeenCalledWith({ data: { ticketId: 't1', authorId: 'agent-1', isStaff: true, internal: false, body: 'Bonjour, voici la solution.' } });
    expect(tx.supportTicket.update.mock.calls[0][0].data).toMatchObject({ status: 'WAITING_USER', assigneeId: 'agent-1' });
    expect(notifications.notify).toHaveBeenCalledWith('u1', 'SUPPORT_REPLY', { ticketId: 't1', number: 42 });
  });

  it("une note interne ne change rien pour l'utilisateur : ni statut, ni alerte", async () => {
    const { service, tx, notifications } = make({ ticket: base });
    await service.replyAsStaff('agent-1', 't1', { body: 'Vérifier le paiement Notch Pay', internal: true });
    expect(tx.ticketMessage.create.mock.calls[0][0].data.internal).toBe(true);
    expect(tx.supportTicket.update).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it("ne reprend pas la demande d'un collègue, et une demande résolue le reste", async () => {
    const taken = make({ ticket: { ...base, assigneeId: 'agent-2' } });
    await taken.service.replyAsStaff('agent-1', 't1', { body: 'Réponse' });
    expect(taken.tx.supportTicket.update.mock.calls[0][0].data.assigneeId).toBe('agent-2');
    const resolved = make({ ticket: { ...base, status: 'RESOLVED' } });
    await resolved.service.replyAsStaff('agent-1', 't1', { body: 'Précision' });
    expect(resolved.tx.supportTicket.update.mock.calls[0][0].data.status).toBe('RESOLVED');
  });

  it('refuse de répondre sur une demande clôturée', async () => {
    const { service, tx } = make({ ticket: { ...base, status: 'CLOSED' } });
    await expect(service.replyAsStaff('agent-1', 't1', { body: 'Allô' })).rejects.toThrow(ConflictException);
    expect(tx.ticketMessage.create).not.toHaveBeenCalled();
  });
});

describe('SupportService — assignation et statut', () => {
  const ticket = { id: 't1', number: 42, userId: 'u1', status: 'OPEN', assigneeId: null, _count: { messages: 1 } };

  it("se l'attribuer soi-même : permis au support, passe « ouverte » à « en cours », et journalisé", async () => {
    const { service, tx } = make({ ticket, users: { agent: SUPPORT } });
    await service.assign('agent', 't1', { assigneeId: 'agent' });
    expect(tx.supportTicket.update.mock.calls[0][0].data).toEqual({ assigneeId: 'agent', status: 'IN_PROGRESS' });
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: { actorId: 'agent', action: 'support.assign', targetType: 'SupportTicket', targetId: 't1', meta: { from: null, to: 'agent' } } });
  });

  it("l'attribuer à un AUTRE demande d'être responsable d'équipe", async () => {
    const support = make({ ticket, users: { agent: SUPPORT, other: SUPPORT } });
    await expect(support.service.assign('agent', 't1', { assigneeId: 'other' })).rejects.toThrow(ForbiddenException);
    expect(support.tx.supportTicket.update).not.toHaveBeenCalled();

    const boss = make({ ticket, users: { boss: SUPER, other: SUPPORT } });
    await expect(boss.service.assign('boss', 't1', { assigneeId: 'other' })).resolves.toBeTruthy();
  });

  it("refuse d'assigner à quelqu'un qui n'a pas l'accès support", async () => {
    const { service, tx } = make({ ticket, users: { boss: SUPER, fin: FINANCE } });
    await expect(service.assign('boss', 't1', { assigneeId: 'fin' })).rejects.toThrow(ConflictException);
    expect(tx.supportTicket.update).not.toHaveBeenCalled();
  });

  it("retirer l'assignation est possible et journalisé", async () => {
    const { service, tx } = make({ ticket: { ...ticket, assigneeId: 'agent' }, users: { agent: SUPPORT } });
    await service.assign('agent', 't1', { assigneeId: null });
    expect(tx.supportTicket.update.mock.calls[0][0].data.assigneeId).toBeNull();
    expect(tx.auditLog.create.mock.calls[0][0].data.meta).toEqual({ from: 'agent', to: null });
  });

  it("changer le statut est journalisé (de → vers) ; « résolue » prévient l'utilisateur", async () => {
    const { service, tx, notifications } = make({ ticket });
    await service.setStatus('agent', 't1', { status: 'RESOLVED' });
    expect(tx.auditLog.create.mock.calls[0][0].data).toMatchObject({ action: 'support.status', meta: { from: 'OPEN', to: 'RESOLVED' } });
    expect(notifications.notify).toHaveBeenCalledWith('u1', 'SUPPORT_TICKET_RESOLVED', { ticketId: 't1', number: 42 });
  });

  it('clôturer enregistre la date ; rouvrir l\'efface ; un statut inchangé ne fait rien', async () => {
    const closed = make({ ticket });
    await closed.service.setStatus('agent', 't1', { status: 'CLOSED' });
    expect(closed.tx.supportTicket.update.mock.calls[0][0].data.closedAt).toBeInstanceOf(Date);
    const reopened = make({ ticket: { ...ticket, status: 'CLOSED' } });
    await reopened.service.setStatus('agent', 't1', { status: 'OPEN' });
    expect(reopened.tx.supportTicket.update.mock.calls[0][0].data.closedAt).toBeNull();
    const same = make({ ticket });
    await same.service.setStatus('agent', 't1', { status: 'OPEN' });
    expect(same.tx.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('SupportService.listForStaff', () => {
  it("« à moi » filtre sur la personne connectée, « non assignées » sur aucune assignation", async () => {
    const { service, prisma } = make();
    await service.listForStaff('agent', { scope: 'mine' });
    expect(prisma.supportTicket.findMany.mock.calls[0][0].where.assigneeId).toBe('agent');
    await service.listForStaff('agent', { scope: 'unassigned' });
    expect(prisma.supportTicket.findMany.mock.calls[1][0].where.assigneeId).toBeNull();
    await service.listForStaff('agent', { scope: 'nimporte' as never });
    expect(prisma.supportTicket.findMany.mock.calls[2][0].where.assigneeId).toBeUndefined();
  });

  it('retrouve une demande par son numéro « SR-0042 » ou par son objet', async () => {
    const { service, prisma } = make();
    await service.listForStaff('agent', { q: 'SR-0042' });
    expect(prisma.supportTicket.findMany.mock.calls[0][0].where.OR).toEqual([{ subject: { contains: 'SR-0042', mode: 'insensitive' } }, { number: 42 }]);
    await service.listForStaff('agent', { q: 'paiement' });
    expect(prisma.supportTicket.findMany.mock.calls[1][0].where.OR).toEqual([{ subject: { contains: 'paiement', mode: 'insensitive' } }]);
  });

  it('« actives » exclut les demandes résolues et clôturées', async () => {
    const { service, prisma } = make();
    await service.listForStaff('agent', { status: 'active' });
    expect(prisma.supportTicket.findMany.mock.calls[0][0].where.status).toEqual({ in: ['OPEN', 'IN_PROGRESS', 'WAITING_USER'] });
  });
});

describe('Contrôleurs — qui a le droit', () => {
  const reflector = new Reflector();
  it("les routes de l'équipe exigent le rôle ADMIN et l'accès « support.manage »", () => {
    expect(reflector.get(ROLES_KEY, SupportAdminController)).toEqual(['ADMIN']);
    expect(reflector.get(PERMISSIONS_KEY, SupportAdminController)).toEqual(['support.manage']);
  });
  it("les routes de l'utilisateur n'exigent aucun accès d'équipe", () => {
    expect(reflector.get(PERMISSIONS_KEY, SupportController)).toBeUndefined();
    expect(reflector.get(ROLES_KEY, SupportController)).toBeUndefined();
  });
});

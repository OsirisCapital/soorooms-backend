/**
 * Support : les demandes (tickets) des utilisateurs et leur traitement par l'équipe.
 *
 * Règles de sécurité :
 *  - un utilisateur ne voit que SES demandes (l'identifiant vient du jeton, jamais de l'adresse) ;
 *  - les notes internes ne lui sont JAMAIS renvoyées ;
 *  - les réponses de l'équipe lui apparaissent sous « Support SòôRooms », sans nom de personne ;
 *  - toute modification de traitement (assignation, statut) est écrite dans le journal d'audit,
 *    dans la même transaction que la modification.
 */
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { permissionsFor } from '../admin/permissions.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type { AssignTicketDto, CreateTicketDto, SetTicketStatusDto, StaffReplyDto, TicketReplyDto } from './dto/support.dto.js';

/** Au-delà, un utilisateur doit attendre qu'une demande soit traitée : évite l'inondation. */
export const MAX_ACTIVE_TICKETS_PER_USER = 5;
/** Une conversation ne grandit pas sans limite. */
export const MAX_MESSAGES_PER_TICKET = 200;

const ACTIVE = ['OPEN', 'IN_PROGRESS', 'WAITING_USER'] as const;

type StaffScope = 'all' | 'mine' | 'unassigned';

@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  // -------------------------------------------------------------------
  // Côté utilisateur
  // -------------------------------------------------------------------

  async createTicket(userId: string, dto: CreateTicketDto) {
    const active = await this.prisma.supportTicket.count({ where: { userId, status: { in: [...ACTIVE] } } });
    if (active >= MAX_ACTIVE_TICKETS_PER_USER) {
      throw new ConflictException(
        `Vous avez déjà ${MAX_ACTIVE_TICKETS_PER_USER} demandes en cours. Attendez une réponse ou clôturez-en une avant d'en ouvrir une nouvelle.`,
      );
    }

    if (dto.bookingId) await this.assertCanReferenceBooking(userId, dto.bookingId);

    const ticket = await this.prisma.$transaction(async (tx) => {
      const created = await tx.supportTicket.create({
        data: { userId, subject: dto.subject, category: dto.category, bookingId: dto.bookingId },
        select: { id: true, number: true, subject: true, category: true, status: true, createdAt: true },
      });
      await tx.ticketMessage.create({ data: { ticketId: created.id, authorId: userId, isStaff: false, body: dto.message } });
      return created;
    });

    await this.notifications.notifyStaff('support.manage', 'SUPPORT_TICKET_NEW', { ticketId: ticket.id, number: ticket.number, subject: ticket.subject }, userId);
    return ticket;
  }

  listMine(userId: string) {
    return this.prisma.supportTicket.findMany({
      where: { userId },
      orderBy: { lastMessageAt: 'desc' },
      take: 50,
      select: { id: true, number: true, subject: true, category: true, status: true, lastMessageAt: true, createdAt: true },
    });
  }

  async getMine(userId: string, ticketId: string) {
    const ticket = await this.prisma.supportTicket.findFirst({
      where: { id: ticketId, userId },
      select: {
        id: true,
        number: true,
        subject: true,
        category: true,
        status: true,
        bookingId: true,
        createdAt: true,
        // Jamais les notes internes.
        messages: { where: { internal: false }, orderBy: { createdAt: 'asc' }, select: { id: true, isStaff: true, body: true, createdAt: true } },
      },
    });
    if (!ticket) throw new NotFoundException('Demande introuvable.');
    return ticket;
  }

  async replyAsUser(userId: string, ticketId: string, dto: TicketReplyDto) {
    const ticket = await this.prisma.supportTicket.findFirst({
      where: { id: ticketId, userId },
      select: { id: true, number: true, status: true, assigneeId: true, _count: { select: { messages: true } } },
    });
    if (!ticket) throw new NotFoundException('Demande introuvable.');
    if (ticket.status === 'CLOSED') {
      throw new ConflictException('Cette demande est clôturée. Ouvrez-en une nouvelle si besoin.');
    }
    if (ticket._count.messages >= MAX_MESSAGES_PER_TICKET) {
      throw new ConflictException('Cette conversation est trop longue : ouvrez une nouvelle demande.');
    }

    const author = await this.prisma.user.findUnique({ where: { id: userId }, select: { fullName: true } });
    await this.prisma.$transaction(async (tx) => {
      await tx.ticketMessage.create({ data: { ticketId, authorId: userId, isStaff: false, body: dto.body } });
      await tx.supportTicket.update({
        where: { id: ticketId },
        // Une réponse de l'utilisateur rouvre une demande résolue ou en attente de sa part.
        data: { lastMessageAt: new Date(), status: ticket.status === 'WAITING_USER' || ticket.status === 'RESOLVED' ? 'OPEN' : ticket.status },
      });
    });

    const payload = { ticketId, number: ticket.number, fromName: author?.fullName ?? 'Un utilisateur' };
    if (ticket.assigneeId) await this.notifications.notify(ticket.assigneeId, 'SUPPORT_USER_REPLY', payload);
    else await this.notifications.notifyStaff('support.manage', 'SUPPORT_USER_REPLY', payload, userId);
    return this.getMine(userId, ticketId);
  }

  async closeAsUser(userId: string, ticketId: string) {
    // Le filtre sur userId empêche de clôturer la demande d'un autre ; une demande déjà clôturée ne change pas.
    await this.prisma.supportTicket.updateMany({
      where: { id: ticketId, userId, status: { not: 'CLOSED' } },
      data: { status: 'CLOSED', closedAt: new Date() },
    });
    return this.getMine(userId, ticketId); // 404 si la demande n'existe pas ou n'est pas à lui
  }

  // -------------------------------------------------------------------
  // Côté équipe (accès « support.manage », vérifié par le contrôleur)
  // -------------------------------------------------------------------

  async listForStaff(staffId: string, filters: { status?: string; scope?: StaffScope; q?: string }) {
    const scope: StaffScope = filters.scope === 'mine' || filters.scope === 'unassigned' ? filters.scope : 'all';
    const q = filters.q?.trim().slice(0, 80);
    const numberQuery = q ? Number(q.replace(/^sr-?/i, '')) : NaN;

    return this.prisma.supportTicket.findMany({
      where: {
        status: filters.status === 'active' ? { in: [...ACTIVE] } : filters.status && filters.status !== 'all' ? (filters.status as never) : undefined,
        assigneeId: scope === 'mine' ? staffId : scope === 'unassigned' ? null : undefined,
        OR: q
          ? [{ subject: { contains: q, mode: 'insensitive' } }, ...(Number.isInteger(numberQuery) ? [{ number: numberQuery }] : [])]
          : undefined,
      },
      orderBy: { lastMessageAt: 'desc' },
      take: 100,
      select: {
        id: true,
        number: true,
        subject: true,
        category: true,
        status: true,
        lastMessageAt: true,
        createdAt: true,
        user: { select: { id: true, fullName: true } },
        assignee: { select: { id: true, fullName: true } },
      },
    });
  }

  async getForStaff(ticketId: string) {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      select: {
        id: true,
        number: true,
        subject: true,
        category: true,
        status: true,
        bookingId: true,
        createdAt: true,
        closedAt: true,
        user: { select: { id: true, fullName: true, phone: true, email: true, role: true } },
        assignee: { select: { id: true, fullName: true } },
        messages: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, isStaff: true, internal: true, body: true, createdAt: true, author: { select: { id: true, fullName: true } } },
        },
      },
    });
    if (!ticket) throw new NotFoundException('Demande introuvable.');
    return ticket;
  }

  async replyAsStaff(staffId: string, ticketId: string, dto: StaffReplyDto) {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      select: { id: true, number: true, userId: true, status: true, assigneeId: true, _count: { select: { messages: true } } },
    });
    if (!ticket) throw new NotFoundException('Demande introuvable.');
    if (ticket.status === 'CLOSED') throw new ConflictException('Cette demande est clôturée.');
    if (ticket._count.messages >= MAX_MESSAGES_PER_TICKET) throw new ConflictException('Cette conversation est trop longue.');

    const internal = dto.internal === true;
    await this.prisma.$transaction(async (tx) => {
      await tx.ticketMessage.create({ data: { ticketId, authorId: staffId, isStaff: true, internal, body: dto.body } });
      // Une note interne ne change rien pour l'utilisateur : ni statut, ni date, ni alerte.
      if (!internal) {
        await tx.supportTicket.update({
          where: { id: ticketId },
          data: {
            lastMessageAt: new Date(),
            status: ticket.status === 'RESOLVED' ? 'RESOLVED' : 'WAITING_USER',
            // Première réponse : la personne qui répond prend la demande.
            assigneeId: ticket.assigneeId ?? staffId,
          },
        });
      }
    });

    if (!internal) await this.notifications.notify(ticket.userId, 'SUPPORT_REPLY', { ticketId, number: ticket.number });
    return this.getForStaff(ticketId);
  }

  /**
   * Assigne la demande. Se l'attribuer à soi-même ne demande que « support.manage » ; l'attribuer
   * à quelqu'un d'autre demande en plus « staff.manage » (responsable d'équipe). La personne
   * désignée doit elle-même avoir « support.manage ».
   */
  async assign(staffId: string, ticketId: string, dto: AssignTicketDto) {
    const assigneeId = dto.assigneeId;
    if (assigneeId !== null && assigneeId !== staffId) {
      const actor = await this.prisma.user.findUnique({ where: { id: staffId }, select: { role: true, staffRole: true, staffPermissions: true } });
      if (!actor || !permissionsFor(actor).includes('staff.manage')) {
        throw new ForbiddenException("Seul un responsable d'équipe peut assigner une demande à quelqu'un d'autre.");
      }
    }
    if (assigneeId !== null) {
      const target = await this.prisma.user.findUnique({ where: { id: assigneeId }, select: { role: true, staffRole: true, staffPermissions: true } });
      if (!target || !permissionsFor(target).includes('support.manage')) {
        throw new ConflictException("Cette personne ne fait pas partie de l'équipe support.");
      }
    }

    const ticket = await this.prisma.supportTicket.findUnique({ where: { id: ticketId }, select: { id: true, status: true, assigneeId: true } });
    if (!ticket) throw new NotFoundException('Demande introuvable.');

    await this.prisma.$transaction(async (tx) => {
      await tx.supportTicket.update({
        where: { id: ticketId },
        data: { assigneeId, status: assigneeId && ticket.status === 'OPEN' ? 'IN_PROGRESS' : undefined },
      });
      await tx.auditLog.create({
        data: { actorId: staffId, action: 'support.assign', targetType: 'SupportTicket', targetId: ticketId, meta: { from: ticket.assigneeId, to: assigneeId } },
      });
    });
    return this.getForStaff(ticketId);
  }

  async setStatus(staffId: string, ticketId: string, dto: SetTicketStatusDto) {
    const ticket = await this.prisma.supportTicket.findUnique({ where: { id: ticketId }, select: { id: true, number: true, userId: true, status: true } });
    if (!ticket) throw new NotFoundException('Demande introuvable.');
    if (ticket.status === dto.status) return this.getForStaff(ticketId);

    await this.prisma.$transaction(async (tx) => {
      await tx.supportTicket.update({
        where: { id: ticketId },
        data: { status: dto.status, closedAt: dto.status === 'CLOSED' ? new Date() : null },
      });
      await tx.auditLog.create({
        data: { actorId: staffId, action: 'support.status', targetType: 'SupportTicket', targetId: ticketId, meta: { from: ticket.status, to: dto.status } },
      });
    });

    if (dto.status === 'RESOLVED') await this.notifications.notify(ticket.userId, 'SUPPORT_TICKET_RESOLVED', { ticketId, number: ticket.number });
    return this.getForStaff(ticketId);
  }

  /** Nombre de demandes à traiter (ouvertes ou non assignées), pour le tableau de bord de l'équipe. */
  async countToHandle() {
    const [open, unassigned] = await Promise.all([
      this.prisma.supportTicket.count({ where: { status: 'OPEN' } }),
      this.prisma.supportTicket.count({ where: { assigneeId: null, status: { in: [...ACTIVE] } } }),
    ]);
    return { open, unassigned };
  }

  // -------------------------------------------------------------------

  private async assertCanReferenceBooking(userId: string, bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { travelerId: true, room: { select: { property: { select: { collaborators: { select: { userId: true } } } } } } },
    });
    const involved = booking && (booking.travelerId === userId || booking.room.property.collaborators.some((c) => c.userId === userId));
    // Même réponse si la réservation n'existe pas ou n'est pas à lui : on ne révèle rien.
    if (!involved) throw new NotFoundException('Réservation introuvable.');
  }
}

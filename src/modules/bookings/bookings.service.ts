/**
 * Réservation avec négociation de prix obligatoire : aucune réservation ne
 * bascule vers le paiement sans qu'une offre ait été explicitement
 * acceptée par la partie qui ne l'a pas proposée. Le voyageur peut aussi
 * bien démarrer avec le prix affiché (pas de négociation réelle, l'hôte
 * accepte immédiatement) que proposer un montant différent — le mécanisme
 * est le même dans les deux cas.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PaymentsService } from '../payments/payments.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { NotificationPayloads, NotificationType } from '../notifications/notification-types.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type { CreateBookingDto } from './dto/create-booking.dto.js';
import type { CreateOfferDto } from './dto/create-offer.dto.js';
import type { RaiseDisputeDto } from './dto/raise-dispute.dto.js';

/** Une notification à envoyer : son type et les données qui la composent (vérifiés ensemble). */
type NotificationSpec = { [K in NotificationType]: [K, NotificationPayloads[K]] }[NotificationType];

// Statuts de réservation qui bloquent réellement le calendrier — une
// négociation en cours (NEGOTIATING) ne réserve rien tant qu'aucun prix
// n'est validé, plusieurs voyageurs peuvent donc négocier en parallèle sur
// les mêmes dates ; seule la première à aboutir les verrouille.
const BLOCKING_STATUSES = ['PENDING_PAYMENT', 'CONFIRMED_ESCROW', 'COMPLETED'] as const;

@Injectable()
export class BookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentsService: PaymentsService,
    private readonly notifications: NotificationsService,
  ) {}

  async create(travelerId: string, dto: CreateBookingDto) {
    const checkInDate = new Date(dto.checkInDate);
    const checkOutDate = new Date(dto.checkOutDate);
    if (checkOutDate <= checkInDate) {
      throw new BadRequestException("La date de départ doit être postérieure à la date d'arrivée.");
    }

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    if (checkInDate < today) {
      throw new BadRequestException("La date d'arrivée ne peut pas être dans le passé.");
    }

    const room = await this.prisma.room.findUnique({
      where: { id: dto.roomId },
      include: { property: { include: { collaborators: true } } },
    });
    if (!room) {
      throw new NotFoundException('Chambre introuvable.');
    }
    if (room.property.status !== 'ACTIVE') {
      throw new BadRequestException("Ce logement n'est pas encore publié.");
    }
    if (room.property.collaborators.some((c) => c.userId === travelerId)) {
      throw new ForbiddenException('Vous ne pouvez pas réserver un logement que vous gérez.');
    }

    await this.assertNoOverlap(dto.roomId, checkInDate, checkOutDate);

    const proposedPrice = dto.proposedPrice ?? this.computeDefaultPrice(room.basePrice, checkInDate, checkOutDate);

    const booking = await this.prisma.$transaction(async (tx) => {
      const created = await tx.booking.create({
        data: { roomId: dto.roomId, travelerId, checkInDate, checkOutDate },
      });
      await tx.priceOffer.create({
        data: { bookingId: created.id, proposedByUserId: travelerId, amount: proposedPrice },
      });
      return created;
    });

    // Prévient les gestionnaires du logement (jamais bloquant : la réservation est déjà créée).
    const traveler = await this.prisma.user.findUnique({ where: { id: travelerId }, select: { fullName: true } });
    await this.notifications.notifyMany(
      room.property.collaborators.map((c) => c.userId),
      'BOOKING_REQUESTED',
      { bookingId: booking.id, travelerName: traveler?.fullName ?? 'Un voyageur', propertyTitle: room.property.title, amount: Number(proposedPrice) },
    );

    return this.findOne(booking.id, travelerId);
  }

  async findMine(travelerId: string) {
    return this.prisma.booking.findMany({
      where: { travelerId },
      include: { room: true, offers: { orderBy: { createdAt: 'desc' }, take: 1 } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findForProperty(propertyId: string) {
    return this.prisma.booking.findMany({
      where: { room: { propertyId } },
      include: { room: true, offers: { orderBy: { createdAt: 'desc' }, take: 1 } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(bookingId: string, userId: string) {
    const booking = await this.loadBookingContext(bookingId);
    this.assertParticipant(booking, userId);
    return booking;
  }

  // ---------------------------------------------------------------------
  // Négociation — contre-offre, acceptation, rejet.
  // ---------------------------------------------------------------------

  async counterOffer(bookingId: string, userId: string, dto: CreateOfferDto) {
    const booking = await this.loadBookingContext(bookingId);
    this.assertParticipant(booking, userId);
    this.assertNegotiating(booking);

    const currentOffer = booking.offers[0];
    if (currentOffer.proposedByUserId === userId) {
      throw new ForbiddenException(
        'Vous ne pouvez pas contre-proposer votre propre offre — attendez la réponse de l\'autre partie.',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.priceOffer.update({ where: { id: currentOffer.id }, data: { status: 'SUPERSEDED' } });
      await tx.priceOffer.create({
        data: { bookingId, proposedByUserId: userId, amount: dto.amount },
      });
    });

    const actor = await this.prisma.user.findUnique({ where: { id: userId }, select: { fullName: true } });
    await this.notifyOthers(booking, userId, (audience) => ['OFFER_RECEIVED', { bookingId, audience, amount: Number(dto.amount), fromName: actor?.fullName ?? 'Votre interlocuteur' }]);

    return this.findOne(bookingId, userId);
  }

  async acceptOffer(bookingId: string, userId: string) {
    const booking = await this.loadBookingContext(bookingId);
    this.assertParticipant(booking, userId);
    this.assertNegotiating(booking);

    const currentOffer = booking.offers[0];
    if (currentOffer.proposedByUserId === userId) {
      throw new ForbiddenException('Vous ne pouvez pas accepter votre propre offre.');
    }

    await this.prisma.$transaction(async (tx) => {
      // Verrou sur la chambre : deux acceptations simultanées sur les mêmes
      // dates s'exécutent l'une après l'autre, et la seconde voit les dates
      // déjà prises. Sans ce verrou, la vérification de chevauchement et la
      // mise à jour étaient deux étapes séparées — double réservation possible.
      await tx.$queryRaw`SELECT id FROM "Room" WHERE id = ${booking.roomId} FOR UPDATE`;
      await this.assertNoOverlap(booking.roomId, booking.checkInDate, booking.checkOutDate, booking.id, tx);

      // Garde atomique : l'offre doit toujours être celle en attente (une
      // contre-offre a pu arriver entre-temps) et la négociation ouverte.
      const offer = await tx.priceOffer.updateMany({
        where: { id: currentOffer.id, status: 'PENDING' },
        data: { status: 'ACCEPTED' },
      });
      const updated = await tx.booking.updateMany({
        where: { id: bookingId, status: 'NEGOTIATING' },
        data: { status: 'PENDING_PAYMENT', totalPrice: currentOffer.amount },
      });
      if (offer.count === 0 || updated.count === 0) {
        throw new ConflictException("Cette offre n'est plus d'actualité — rechargez la réservation.");
      }
    });

    await this.notifyOthers(booking, userId, (audience) => [
      'OFFER_ACCEPTED',
      { bookingId, audience, amount: Number(currentOffer.amount), propertyTitle: booking.room.property.title },
    ]);

    return this.findOne(bookingId, userId);
  }

  async rejectOffer(bookingId: string, userId: string) {
    const booking = await this.loadBookingContext(bookingId);
    this.assertParticipant(booking, userId);
    this.assertNegotiating(booking);

    const currentOffer = booking.offers[0];

    await this.prisma.$transaction(async (tx) => {
      await tx.priceOffer.update({ where: { id: currentOffer.id }, data: { status: 'REJECTED' } });
      await tx.booking.update({ where: { id: bookingId }, data: { status: 'CANCELLED' } });
    });

    await this.notifyOthers(booking, userId, (audience) => ['OFFER_REJECTED', { bookingId, audience, propertyTitle: booking.room.property.title }]);

    return this.findOne(bookingId, userId);
  }

  // ---------------------------------------------------------------------
  // Double validation post-paiement — déclenche le reversement à l'hôte
  // uniquement lorsque les DEUX parties ont confirmé, jamais avant.
  // ---------------------------------------------------------------------

  async confirmCheckin(bookingId: string, userId: string) {
    const booking = await this.loadBookingContext(bookingId);
    if (booking.travelerId !== userId) {
      throw new ForbiddenException('Seul le voyageur peut confirmer sa prise de possession du logement.');
    }
    this.assertConfirmedEscrow(booking);

    // Conserve la première confirmation (un second clic ne doit pas la déplacer).
    await this.prisma.booking.update({
      where: { id: bookingId },
      data: { travelerConfirmedAt: booking.travelerConfirmedAt ?? new Date() },
    });

    const completed = await this.maybeComplete(bookingId);
    // Première confirmation seulement (un second clic ne doit pas renotifier), et pas si la
    // réservation vient de se terminer (les notifications de fin partent alors dans maybeComplete).
    if (!completed && !booking.travelerConfirmedAt && !booking.hostConfirmedAt) {
      const traveler = await this.prisma.user.findUnique({ where: { id: userId }, select: { fullName: true } });
      await this.notifications.notifyMany(
        booking.room.property.collaborators.map((c) => c.userId),
        'STAY_CONFIRMATION_REQUESTED',
        { bookingId, audience: 'host', otherName: traveler?.fullName ?? 'Le voyageur' },
      );
    }
    return this.findOne(bookingId, userId);
  }

  async confirmHosting(bookingId: string, userId: string) {
    const booking = await this.loadBookingContext(bookingId);
    const isCollaborator = booking.room.property.collaborators.some((c) => c.userId === userId);
    if (!isCollaborator) {
      throw new ForbiddenException("Vous n'êtes pas gestionnaire de ce logement.");
    }
    this.assertConfirmedEscrow(booking);

    await this.prisma.booking.update({
      where: { id: bookingId },
      data: { hostConfirmedAt: booking.hostConfirmedAt ?? new Date() },
    });

    const completed = await this.maybeComplete(bookingId);
    if (!completed && !booking.hostConfirmedAt && !booking.travelerConfirmedAt) {
      const host = await this.prisma.user.findUnique({ where: { id: userId }, select: { fullName: true } });
      await this.notifications.notify(booking.travelerId, 'STAY_CONFIRMATION_REQUESTED', {
        bookingId,
        audience: 'traveler',
        otherName: host?.fullName ?? "L'hôte",
      });
    }
    return this.findOne(bookingId, userId);
  }

  async raiseDispute(bookingId: string, userId: string, dto: RaiseDisputeDto) {
    const booking = await this.loadBookingContext(bookingId);
    this.assertParticipant(booking, userId);
    this.assertConfirmedEscrow(booking);

    // Gèle la réservation sans toucher au séquestre : les fonds restent
    // HELD_IN_ESCROW (aucun code ne les libère depuis cet état) en
    // attendant une résolution manuelle — voir le commentaire sur
    // disputeReason dans schema.prisma.
    await this.prisma.booking.update({
      where: { id: bookingId },
      data: { status: 'DISPUTED', disputeReason: dto.reason },
    });
    await this.notifyOthers(booking, userId, (audience) => ['DISPUTE_OPENED', { bookingId, audience }]);
    await this.notifications.notifyStaff('disputes.view', 'DISPUTE_OPENED_STAFF', { bookingId });
    return this.findOne(bookingId, userId);
  }

  /** Passe la réservation à COMPLETED et déclenche le reversement dès que
   *  les deux confirmations sont réunies — sans effet sinon. */
  private async maybeComplete(bookingId: string): Promise<boolean> {
    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId } });
    if (booking?.travelerConfirmedAt && booking?.hostConfirmedAt) {
      // Le reversement passe AVANT le changement de statut : s'il échoue
      // (agrégateur indisponible), la réservation reste CONFIRMED_ESCROW avec
      // les deux confirmations enregistrées, et un nouvel appel à
      // confirm-checkin / confirm-hosting relance simplement le reversement.
      // L'ancien ordre laissait une réservation COMPLETED dont les fonds
      // restaient bloqués, sans aucun moyen de réessayer.
      const escrow = await this.paymentsService.releaseEscrow(bookingId);
      const done = await this.prisma.booking.updateMany({
        where: { id: bookingId, status: 'CONFIRMED_ESCROW' },
        data: { status: 'COMPLETED' },
      });
      // Notifié une seule fois : seulement si CET appel a fait passer la réservation à COMPLETED.
      if (done.count > 0) {
        await this.notifyCompletion(bookingId, Number(escrow.hostPayout));
        return true;
      }
    }
    return false;
  }

  private async notifyCompletion(bookingId: string, hostPayout: number) {
    const booking = await this.loadBookingContext(bookingId).catch(() => null);
    if (!booking) return;
    const propertyTitle = booking.room.property.title;
    await this.notifications.notify(booking.travelerId, 'BOOKING_COMPLETED', { bookingId, propertyTitle });
    await this.notifications.notifyMany(
      booking.room.property.collaborators.map((c) => c.userId),
      'PAYOUT_RELEASED',
      { bookingId, amount: hostPayout, propertyTitle },
    );
  }

  /**
   * Prévient « l'autre côté » de la réservation : le voyageur (s'il n'est pas l'auteur) et les
   * gestionnaires du logement (sauf l'auteur). Le texte dépend du destinataire (voyageur ou hôte).
   */
  private async notifyOthers(
    booking: Awaited<ReturnType<BookingsService['loadBookingContext']>>,
    actorId: string,
    build: (audience: 'traveler' | 'host') => NotificationSpec,
  ) {
    const send = async (userId: string, audience: 'traveler' | 'host') => {
      const [type, payload] = build(audience);
      await this.notifications.notify(userId, type, payload as never);
    };
    if (booking.travelerId !== actorId) await send(booking.travelerId, 'traveler');
    for (const collaborator of booking.room.property.collaborators) {
      if (collaborator.userId !== actorId) await send(collaborator.userId, 'host');
    }
  }

  private assertConfirmedEscrow(booking: { status: string }) {
    if (booking.status !== 'CONFIRMED_ESCROW') {
      throw new ConflictException(
        "Cette réservation doit être payée (CONFIRMED_ESCROW) avant de pouvoir être confirmée ou contestée.",
      );
    }
  }

  // ---------------------------------------------------------------------
  // Aides internes
  // ---------------------------------------------------------------------

  private async loadBookingContext(bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        room: { include: { property: { include: { collaborators: true } } } },
        offers: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!booking) {
      throw new NotFoundException('Réservation introuvable.');
    }
    return booking;
  }

  private assertParticipant(
    booking: Awaited<ReturnType<BookingsService['loadBookingContext']>>,
    userId: string,
  ) {
    const isTraveler = booking.travelerId === userId;
    const isCollaborator = booking.room.property.collaborators.some((c) => c.userId === userId);
    if (!isTraveler && !isCollaborator) {
      throw new ForbiddenException("Vous n'êtes pas partie prenante de cette réservation.");
    }
  }

  private assertNegotiating(booking: { status: string }) {
    if (booking.status !== 'NEGOTIATING') {
      throw new ConflictException('Cette négociation est terminée.');
    }
  }

  private async assertNoOverlap(
    roomId: string,
    checkInDate: Date,
    checkOutDate: Date,
    excludeBookingId?: string,
    db: Pick<PrismaService, 'booking'> = this.prisma,
  ) {
    const overlapping = await db.booking.findFirst({
      where: {
        roomId,
        id: excludeBookingId ? { not: excludeBookingId } : undefined,
        status: { in: [...BLOCKING_STATUSES] },
        checkInDate: { lt: checkOutDate },
        checkOutDate: { gt: checkInDate },
      },
    });
    if (overlapping) {
      throw new ConflictException('Ces dates ne sont plus disponibles pour cette chambre.');
    }
  }

  private computeDefaultPrice(basePrice: unknown, checkInDate: Date, checkOutDate: Date): number {
    const nights = Math.max(
      1,
      Math.round((checkOutDate.getTime() - checkInDate.getTime()) / (24 * 60 * 60 * 1000)),
    );
    return Number(basePrice) * nights;
  }
}

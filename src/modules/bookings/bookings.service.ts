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
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { LoyaltyService } from '../loyalty/loyalty.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import { can, userIdsWith } from '../../common/utils/collaborator-access.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { NotificationPayloads, NotificationType } from '../notifications/notification-types.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { BLOCKING_STATUSES, unitsLeft } from '../rooms/availability.utils.js';
import { blockAsStay, blockedUnitsOn } from '../rooms/blocks.utils.js';
import { currentHourWat, napFits, NAP_MAX_HOURS, stayFitsHourly } from '../rooms/nap.utils.js';
import { forfeitedAmounts, HALL_DEPOSIT_PERCENT, nextStage } from '../payments/deposit.utils.js';
import { extrasTotal, type ExtraSnapshot } from './extras.utils.js';
import { termEndDate, termPrice } from './stay-term.utils.js';
import { eventDefaultPrice, guestsError, type EventOptionSnapshot, type EventSlot } from './event.utils.js';
import { countNights, invoiceNumber, receiptReference, type Receipt } from './receipt.js';
import { isExpired, MAX_OPEN_REQUESTS, RESPONSE_WINDOW_MS } from './request-window.js';
import type { IssueInvoiceDto } from './dto/invoice.dto.js';
import type { CreateBookingDto } from './dto/create-booking.dto.js';
import type { CreateOfferDto } from './dto/create-offer.dto.js';
import type { RaiseDisputeDto } from './dto/raise-dispute.dto.js';
import type { CancelBookingDto } from './dto/cancel-booking.dto.js';
import type { SetPayoutDetailsDto } from '../payments/dto/payout-details.dto.js';
import { normalizeCameroonMobile } from '../payments/payout-phone.js';
import { decideRefund, type RefundDecision, type RefundKind } from './refund-policy.js';

/** Une notification à envoyer : son type et les données qui la composent (vérifiés ensemble). */
type NotificationSpec = { [K in NotificationType]: [K, NotificationPayloads[K]] }[NotificationType];

// Statuts de réservation qui bloquent réellement le calendrier — une
// négociation en cours (NEGOTIATING) ne réserve rien tant qu'aucun prix
// n'est validé, plusieurs voyageurs peuvent donc négocier en parallèle sur
// les mêmes dates ; seule la première à aboutir les verrouille.

@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentsService: PaymentsService,
    private readonly notifications: NotificationsService,
    // Optionnel : les points de fidélité ne sont qu'un effet secondaire de la clôture d'une réservation.
    @Optional() private readonly loyalty?: LoyaltyService,
  ) {}

  async create(travelerId: string, dto: CreateBookingDto) {
    const checkInDate = new Date(dto.checkInDate);

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

    // Salle de fêtes : un événement = une date (le lendemain sert de borne de fin) + créneau, invités, options.
    const isHall = room.property.propertyType === 'EVENT_HALL';
    // Résidence étudiante : forfait semestre/année à partir de la date d'entrée.
    const isResidence = room.property.propertyType === 'STUDENT_RESIDENCE';
    // Réservation de groupe : plusieurs chambres identiques en une demande (jamais pour une salle).
    // Sieste : quelques heures le jour d'arrivée, au tarif de sieste de la chambre.
    const isNap = dto.nap === true;
    let napHours = 0;
    if (isNap) {
      if (isHall || isResidence) throw new BadRequestException('Les siestes ne sont pas proposées pour ce type de logement.');
      if (!room.allowsNap || room.napPrice == null) throw new BadRequestException("Cette chambre n'accepte pas les siestes.");
      if (dto.napStartHour == null) throw new BadRequestException('Choisissez l\'heure de début de la sieste.');
      napHours = Math.min(room.napHours ?? 3, NAP_MAX_HOURS);
      if (dto.napStartHour + napHours > 24) {
        throw new BadRequestException(`Une sieste de ${napHours} h doit se terminer avant minuit : choisissez une heure plus tôt.`);
      }
      const now = currentHourWat();
      if (dto.checkInDate.slice(0, 10) === now.date && dto.napStartHour < now.hour) {
        throw new BadRequestException("L'heure de début de la sieste est déjà passée.");
      }
    }
    const units = isHall || isNap ? 1 : (dto.units ?? 1);
    if (units > room.unitCount) {
      throw new BadRequestException(`Ce type compte ${room.unitCount} chambre${room.unitCount > 1 ? 's' : ''} au total.`);
    }
    let termAmount: number | null = null;
    if (isResidence) {
      if (!dto.stayTerm) throw new BadRequestException('Choisissez le forfait : semestre ou année.');
      termAmount = termPrice(room, dto.stayTerm);
      if (termAmount == null) throw new BadRequestException("Ce forfait n'est pas proposé pour cette chambre.");
    }
    const checkOutDate = isHall || isNap
      ? new Date(checkInDate.getTime() + 24 * 3_600_000)
      : isResidence && dto.stayTerm
        ? termEndDate(checkInDate, dto.stayTerm)
        : new Date(dto.checkOutDate ?? '');
    if (!isHall && !isNap && !isResidence && (!dto.checkOutDate || checkOutDate <= checkInDate)) {
      throw new BadRequestException("La date de départ doit être postérieure à la date d'arrivée.");
    }
    let eventData: { eventType: string; eventSlot: EventSlot; eventGuests: number; eventOptions: EventOptionSnapshot[] } | null = null;
    let chosenOptions: { id: string; name: string; price: unknown }[] = [];
    // Extras payants (navette, petit-déjeuner…) d'un séjour classique : copie figée des choix du voyageur.
    let extras: ExtraSnapshot[] = [];
    if (!isHall && dto.optionIds?.length) {
      if (isResidence) throw new BadRequestException('Les options ne sont pas proposées pour une résidence étudiante.');
      const ids = [...new Set(dto.optionIds)];
      const found = await this.prisma.hallOption.findMany({ where: { id: { in: ids }, propertyId: room.propertyId } });
      if (found.length !== ids.length) {
        throw new BadRequestException("Une des options choisies n'existe plus. Rechargez la page.");
      }
      extras = found.map((o) => ({ id: o.id, name: o.name, price: Number(o.price), perNight: Boolean((o as { perNight?: boolean }).perNight) }));
    }
    if (isHall) {
      if (!dto.eventType?.trim() || !dto.eventSlot || !dto.eventGuests) {
        throw new BadRequestException("Précisez le type d'événement, le créneau et le nombre d'invités.");
      }
      const tooMany = guestsError(dto.eventGuests, room.maxGuests);
      if (tooMany) throw new BadRequestException(tooMany);
      const ids = [...new Set(dto.optionIds ?? [])];
      chosenOptions = ids.length ? await this.prisma.hallOption.findMany({ where: { id: { in: ids }, propertyId: room.propertyId } }) : [];
      if (chosenOptions.length !== ids.length) {
        throw new BadRequestException("Une des options choisies n'existe plus. Rechargez la page.");
      }
      eventData = {
        eventType: dto.eventType.trim(),
        eventSlot: dto.eventSlot,
        eventGuests: dto.eventGuests,
        eventOptions: chosenOptions.map((o) => ({ id: o.id, name: o.name, price: Number(o.price) })),
      };
    }

    // Quota : un voyageur ne bloque pas plusieurs hôtes à la fois sans réponse.
    await this.expireStale({ travelerId });
    const open = await this.prisma.booking.count({ where: { travelerId, status: 'NEGOTIATING' } });
    if (open >= MAX_OPEN_REQUESTS) {
      throw new ConflictException(
        `Vous avez déjà ${MAX_OPEN_REQUESTS} demandes en attente de réponse. Attendez une réponse (2 h maximum) avant d'en envoyer une autre.`,
      );
    }

    await this.assertUnitAvailable(
      dto.roomId,
      checkInDate,
      checkOutDate,
      undefined,
      this.prisma,
      units,
      isNap ? { startHour: dto.napStartHour as number, hours: napHours } : undefined,
    );

    const proposedPrice =
      dto.proposedPrice ??
      (isNap
        ? Number(room.napPrice) + extrasTotal(extras, 1)
        : isHall
        ? eventDefaultPrice(room.basePrice, chosenOptions)
        : termAmount != null
          ? termAmount * units
          : this.computeDefaultPrice(room.basePrice, checkInDate, checkOutDate) * units +
            extrasTotal(extras, countNights(checkInDate, checkOutDate)));

    const booking = await this.prisma.$transaction(async (tx) => {
      const created = await tx.booking.create({
        data: {
          roomId: dto.roomId,
          travelerId,
          checkInDate,
          checkOutDate,
          guestName: dto.guestName?.trim() || null,
          guestPhone: dto.guestPhone?.replace(/\s+/g, ' ').trim() || null,
          ...(eventData ?? {}),
          ...(isResidence ? { stayTerm: dto.stayTerm } : {}),
          ...(isNap ? { napStartHour: dto.napStartHour, napHours } : {}),
          ...(extras.length ? { extras } : {}),
          units,
          // Salle de fêtes : paiement en deux temps (acompte puis solde), si l'événement est assez loin.
          ...(isHall ? { depositPercent: HALL_DEPOSIT_PERCENT } : {}),
        },
      });
      await tx.priceOffer.create({
        data: { bookingId: created.id, proposedByUserId: travelerId, amount: proposedPrice },
      });
      return created;
    });

    // Prévient les gestionnaires du logement (jamais bloquant : la réservation est déjà créée).
    const traveler = await this.prisma.user.findUnique({ where: { id: travelerId }, select: { fullName: true } });
    await this.notifications.notifyMany(
      userIdsWith(room.property.collaborators, 'bookings.manage'),
      'BOOKING_REQUESTED',
      { bookingId: booking.id, travelerName: traveler?.fullName ?? 'Un voyageur', propertyTitle: room.property.title, amount: Number(proposedPrice) },
    );

    return this.findOne(booking.id, travelerId);
  }

  async findMine(travelerId: string) {
    await this.expireStale({ travelerId });
    return this.prisma.booking.findMany({
      where: { travelerId },
      include: { room: true, offers: { orderBy: { createdAt: 'desc' }, take: 1 } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findForProperty(propertyId: string) {
    await this.expireStale({ propertyId });
    return this.prisma.booking.findMany({
      where: { room: { propertyId } },
      include: { room: true, offers: { orderBy: { createdAt: 'desc' }, take: 1 } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(bookingId: string, userId: string) {
    await this.expireStale({ bookingId });
    const booking = await this.loadBookingContext(bookingId);
    this.assertParticipant(booking, userId);
    // Prochain paiement attendu (paiement unique, acompte ou solde) — sans exposer le détail du séquestre.
    const escrow = await this.prisma.escrowVault.findUnique({
      where: { bookingId },
      select: { amountHeld: true, depositAmount: true, refund: { select: { amount: true, status: true, beneficiaryPhone: true } } },
    });
    // Remboursement en cours (visible du voyageur seulement) : montant, état, et s'il manque encore son numéro.
    const refund = booking.travelerId === userId && escrow?.refund
      ? { amount: Number(escrow.refund.amount), status: escrow.refund.status, hasNumber: !!escrow.refund.beneficiaryPhone }
      : null;
    // Le jeton du lien de paiement est un secret du voyageur : jamais renvoyé tel quel, ni à l'hôte.
    const { payToken, ...safe } = booking as typeof booking & { payToken?: string | null };
    return { ...safe, payLinkActive: booking.travelerId === userId && !!payToken, nextPayment: escrow ? nextStage(booking, escrow) : null, refund };
  }

  /** Reçu du voyageur : disponible dès qu'un paiement a abouti. */
  async getReceipt(bookingId: string, userId: string): Promise<Receipt> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        traveler: { select: { fullName: true } },
        room: { include: { property: true } },
        escrowVault: { include: { transactions: { where: { transactionStatus: 'SUCCESS' }, orderBy: { createdAt: 'asc' } } } },
      },
    });
    if (!booking || booking.travelerId !== userId) {
      throw new NotFoundException('Réservation introuvable.');
    }
    const escrow = booking.escrowVault;
    const payment = escrow?.transactions[0];
    if (!escrow || !payment) {
      throw new ConflictException('Le reçu est disponible une fois le paiement effectué.');
    }
    // Plusieurs paiements possibles (acompte puis solde) : on additionne ce qui est réellement encaissé.
    const totalPaid = escrow.transactions.reduce((sum, t) => sum + Number(t.amount), 0);
    const twoStep = escrow.depositAmount != null;
    const fullPrice = Number(escrow.amountHeld);
    const balanceDue = twoStep ? Math.max(0, fullPrice - totalPaid) : 0;
    const travelerFee = Number(escrow.travelerFee);
    return {
      reference: receiptReference(booking.id),
      issuedAt: payment.createdAt,
      travelerName: booking.traveler.fullName,
      guestName: booking.guestName,
      currency: booking.currency,
      property: { title: booking.room.property.title, city: booking.room.property.city, quarter: booking.room.property.quarter },
      roomName: booking.room.name,
      checkInDate: booking.checkInDate,
      checkOutDate: booking.checkOutDate,
      nights: countNights(booking.checkInDate, booking.checkOutDate),
      stayPrice: (twoStep ? fullPrice : totalPaid) - travelerFee,
      travelerFee,
      travelerFeePercent: escrow.travelerFeePercent === null ? null : Number(escrow.travelerFeePercent),
      totalPaid,
      paymentMethod: payment.paymentMethod,
      refunded: escrow.status === 'REFUNDED_TO_TRAVELER',
      stayTerm: booking.stayTerm ?? null,
      units: booking.units ?? 1,
      nap: booking.napStartHour != null ? { startHour: booking.napStartHour, hours: booking.napHours ?? 1 } : null,
      extras: (booking.extras as ExtraSnapshot[] | null) ?? [],
      balanceDue,
      balanceDueAt: balanceDue > 0 ? booking.balanceDueAt : null,
      invoice:
        booking.invoiceIssuedAt && booking.invoiceCompany && booking.invoiceAddress
          ? {
              number: invoiceNumber(booking.id),
              company: booking.invoiceCompany,
              address: booking.invoiceAddress,
              taxId: booking.invoiceTaxId,
              issuedAt: booking.invoiceIssuedAt,
            }
          : null,
    };
  }

  /**
   * Facture entreprise, à la demande du voyageur et seulement après paiement. Une fois émise, elle
   * ne change plus (une facture modifiée après coup n'est plus une facture) : en cas d'erreur, le support la réinitialise.
   */
  async issueInvoice(bookingId: string, userId: string, dto: IssueInvoiceDto): Promise<Receipt> {
    const receipt = await this.getReceipt(bookingId, userId); // vérifie voyageur + paiement effectué
    if (receipt.invoice) {
      throw new ConflictException('La facture de cette réservation est déjà émise.');
    }
    if (receipt.balanceDue > 0) {
      throw new ConflictException('La facture sera disponible une fois le solde payé.');
    }
    const issued = await this.prisma.booking.updateMany({
      where: { id: bookingId, travelerId: userId, invoiceIssuedAt: null },
      data: {
        invoiceCompany: dto.company,
        invoiceAddress: dto.address,
        invoiceTaxId: dto.taxId?.trim() || null,
        invoiceIssuedAt: new Date(),
      },
    });
    if (issued.count === 0) {
      throw new ConflictException('La facture de cette réservation est déjà émise.');
    }
    return this.getReceipt(bookingId, userId);
  }

  // ---------------------------------------------------------------------
  // Négociation — contre-offre, acceptation, rejet.
  // ---------------------------------------------------------------------

  async counterOffer(bookingId: string, userId: string, dto: CreateOfferDto) {
    const booking = await this.loadBookingContext(bookingId);
    this.assertParticipant(booking, userId);
    this.assertNegotiating(booking);
    await this.assertNotExpired(booking);

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
    await this.assertNotExpired(booking);

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
      await this.assertUnitAvailable(
        booking.roomId,
        booking.checkInDate,
        booking.checkOutDate,
        booking.id,
        tx,
        booking.units,
        booking.napStartHour != null ? { startHour: booking.napStartHour, hours: booking.napHours ?? 1 } : undefined,
      );

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
    await this.assertNotExpired(booking);

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
        userIdsWith(booking.room.property.collaborators, 'bookings.manage'),
        'STAY_CONFIRMATION_REQUESTED',
        { bookingId, audience: 'host', otherName: traveler?.fullName ?? 'Le voyageur' },
      );
    }
    return this.findOne(bookingId, userId);
  }

  async confirmHosting(bookingId: string, userId: string) {
    const booking = await this.loadBookingContext(bookingId);
    const isCollaborator = booking.room.property.collaborators.some((c) => c.userId === userId && can(c.role, 'bookings.manage'));
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

  // ---------------------------------------------------------------------
  // Annulation et remboursement
  // ---------------------------------------------------------------------

  /** Ce qui se passerait si on annulait maintenant (montant remboursé, règle appliquée). Ne modifie rien. */
  async previewCancellation(bookingId: string, userId: string) {
    const ctx = await this.cancellationContext(bookingId, userId);
    const base = { actor: ctx.actor, status: ctx.booking.status, currency: ctx.booking.currency };
    if (!ctx.cancellable) {
      return { ...base, canCancel: false as const, reason: ctx.reason };
    }
    if (!ctx.decision) {
      return { ...base, canCancel: true as const, paid: 0, refund: 0, retained: 0, percent: 0, label: "Rien n'a encore été payé : l'annulation est gratuite.", needsRefundNumber: false };
    }
    const d = ctx.decision;
    if (!d.allowed) return { ...base, canCancel: false as const, reason: d.reason };
    return {
      ...base,
      canCancel: true as const,
      paid: ctx.paid,
      refund: d.refund,
      retained: d.retained,
      percent: d.percent,
      label: d.label,
      needsRefundNumber: ctx.actor === 'TRAVELER' && d.refund > 0,
    };
  }

  /** Annulation par le voyageur (règles de la politique de remboursement) ou par un gérant du logement (100 %). */
  async cancel(bookingId: string, userId: string, dto: CancelBookingDto) {
    const ctx = await this.cancellationContext(bookingId, userId);
    if (!ctx.cancellable) throw new ConflictException(ctx.reason);
    const { booking, actor, decision, escrow } = ctx;
    if (decision && !decision.allowed) throw new ConflictException(decision.reason);
    const money = decision && decision.allowed ? decision : null;
    const refundAmount = money?.refund ?? 0;

    // Un voyageur qui annule doit dire où le rembourser. L'hôte qui annule : le voyageur l'indiquera ensuite.
    let beneficiary: { channel: string; phone: string; name: string } | null = null;
    if (actor === 'TRAVELER' && refundAmount > 0) {
      const phone = dto.refundPhone ? normalizeCameroonMobile(dto.refundPhone) : null;
      const name = dto.refundName?.replace(/\s+/g, ' ').trim();
      if (!dto.refundChannel || !phone || !name || name.length < 2) {
        throw new BadRequestException('Indiquez le numéro Mobile Money (MTN ou Orange, 9 chiffres commençant par 6) et le nom du titulaire pour recevoir votre remboursement.');
      }
      beneficiary = { channel: dto.refundChannel, phone, name };
    }

    const reason = dto.reason?.trim().slice(0, 300) || null;
    const cancelledBy = actor === 'TRAVELER' ? 'TRAVELER_CANCEL' : 'HOST_CANCEL';
    await this.prisma.$transaction(
      async (tx) => {
        const res = await tx.booking.updateMany({
          where: { id: booking.id, status: booking.status },
          data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: userId, cancelReason: reason },
        });
        if (res.count === 0) throw new ConflictException('Cette réservation vient de changer : actualisez la page.');
        await tx.auditLog.create({
          data: { actorId: userId, action: 'booking.cancel', targetType: 'Booking', targetId: booking.id, meta: { actor, status: booking.status, paid: ctx.paid, refund: refundAmount } },
        });
        if (!escrow || !money || ctx.paid <= 0) return;
        // Le séquestre ne garde plus que la part non remboursée, répartie entre l'hôte et la plateforme.
        if (money.refund > 0 || ctx.paid < Number(escrow.amountHeld)) {
          await tx.escrowVault.update({
            where: { id: escrow.id },
            data: {
              amountHeld: money.retained,
              hostPayout: money.hostPayout,
              platformFee: money.retained - money.hostPayout,
              travelerFee: money.travelerFeeKept,
              ...(money.retained > 0 && money.hostPayout === 0 ? { status: 'RELEASED_TO_HOST' as const } : {}),
            },
          });
        }
        if (money.refund > 0) {
          await tx.refund.create({
            data: {
              escrowId: escrow.id,
              travelerId: booking.travelerId,
              amount: money.refund,
              reason: cancelledBy,
              beneficiaryChannel: beneficiary?.channel ?? null,
              beneficiaryPhone: beneficiary?.phone ?? null,
              beneficiaryName: beneficiary?.name ?? null,
            },
          });
        }
      },
      { timeout: 15_000 },
    );

    // La part conservée par l'hôte entre dans la file des versements (la finance valide, comme d'habitude).
    if (money && money.hostPayout > 0) {
      try {
        await this.paymentsService.releaseEscrow(booking.id);
      } catch (error) {
        this.logger.error(`Annulation ${booking.id} : versement à l'hôte non mis en file (${error instanceof Error ? error.message : String(error)}). À traiter à la main.`);
      }
    }

    const by = actor === 'TRAVELER' ? 'traveler' : 'host';
    const propertyTitle = booking.room.property.title;
    await this.notifyOthers(booking, userId, (audience) => ['BOOKING_CANCELLED', { bookingId: booking.id, audience, propertyTitle, by, refundAmount }]);
    if (actor === 'HOST') {
      // Le gérant qui annule reçoit aussi la confirmation sur sa propre page.
      await this.notifications.notify(userId, 'BOOKING_CANCELLED', { bookingId: booking.id, audience: 'host', propertyTitle, by, refundAmount });
    }
    if (refundAmount > 0) {
      await this.notifications.notifyStaff('payouts.manage', 'REFUND_TO_SEND_STAFF', { amount: refundAmount, propertyTitle });
    }
    return this.findOne(bookingId, userId);
  }

  /** Le voyageur indique (ou corrige) le numéro Mobile Money où recevoir un remboursement pas encore envoyé. */
  async setRefundDetails(bookingId: string, userId: string, dto: SetPayoutDetailsDto) {
    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId }, select: { travelerId: true, escrowVault: { select: { refund: { select: { id: true, status: true } } } } } });
    if (!booking || booking.travelerId !== userId) throw new NotFoundException('Réservation introuvable.');
    const refund = booking.escrowVault?.refund;
    if (!refund) throw new ConflictException("Aucun remboursement n'est prévu pour cette réservation.");
    if (refund.status !== 'TO_SEND' && refund.status !== 'FAILED') throw new ConflictException('Ce remboursement est déjà en cours ou terminé.');
    const phone = normalizeCameroonMobile(dto.phone);
    if (!phone) throw new BadRequestException('Numéro invalide : indiquez un numéro mobile camerounais (9 chiffres, commençant par 6).');
    const name = dto.accountName.replace(/\s+/g, ' ').trim();
    if (name.length < 2) throw new BadRequestException('Indiquez le nom du titulaire du compte.');
    const res = await this.prisma.refund.updateMany({
      where: { id: refund.id, status: { in: ['TO_SEND', 'FAILED'] } },
      data: { beneficiaryChannel: dto.channel, beneficiaryPhone: phone, beneficiaryName: name },
    });
    if (res.count === 0) throw new ConflictException('Ce remboursement vient de partir : le numéro ne peut plus changer.');
    return { ok: true };
  }

  /** Charge la réservation et calcule, selon les règles, ce que rapporterait une annulation maintenant. */
  private async cancellationContext(bookingId: string, userId: string) {
    const booking = await this.loadBookingContext(bookingId);
    this.assertParticipant(booking, userId);
    const actor: 'TRAVELER' | 'HOST' = booking.travelerId === userId ? 'TRAVELER' : 'HOST';
    const no = (reason: string) => ({ booking, actor, cancellable: false as const, reason });
    if (booking.status === 'CANCELLED') return no('Cette réservation est déjà annulée.');
    if (booking.status === 'COMPLETED') return no('Cette réservation est terminée.');
    if (booking.status === 'DISPUTED') return no("Un litige est en cours sur cette réservation : l'équipe SòôRooms la traite, les fonds restent bloqués.");
    if (booking.status === 'NEGOTIATING' || booking.status === 'PENDING_PAYMENT') {
      return { booking, actor, cancellable: true as const, decision: null, paid: 0, escrow: null };
    }
    const escrow = await this.prisma.escrowVault.findUnique({
      where: { bookingId },
      include: { transactions: { where: { transactionStatus: 'SUCCESS' }, select: { amount: true } } },
    });
    if (!escrow) return no("Aucun paiement n'a été trouvé pour cette réservation.");
    const paid = escrow.transactions.reduce((sum, t) => sum + Number(t.amount), 0);
    const type = booking.room.property.propertyType;
    const kind: RefundKind = booking.napStartHour != null ? 'NAP' : type === 'EVENT_HALL' ? 'HALL' : type === 'STUDENT_RESIDENCE' ? 'RESIDENCE' : 'NIGHT';
    const decision: RefundDecision = decideRefund({
      kind,
      checkInDate: booking.checkInDate,
      napStartHour: booking.napStartHour,
      now: new Date(),
      actor,
      amountHeld: Number(escrow.amountHeld),
      travelerFee: Number(escrow.travelerFee),
      hostPayout: Number(escrow.hostPayout),
      depositAmount: escrow.depositAmount == null ? null : Number(escrow.depositAmount),
      paid,
    });
    return { booking, actor, cancellable: true as const, decision, paid, escrow };
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
      await this.paymentsService.releaseEscrow(bookingId);
      const done = await this.prisma.booking.updateMany({
        where: { id: bookingId, status: 'CONFIRMED_ESCROW' },
        data: { status: 'COMPLETED' },
      });
      // Notifié une seule fois : seulement si CET appel a fait passer la réservation à COMPLETED.
      if (done.count > 0) {
        await this.notifyCompletion(bookingId);
        await this.loyalty?.awardForCompletedBooking(bookingId);
        return true;
      }
    }
    return false;
  }

  private async notifyCompletion(bookingId: string) {
    const booking = await this.loadBookingContext(bookingId).catch(() => null);
    if (!booking) return;
    await this.notifications.notify(booking.travelerId, 'BOOKING_COMPLETED', { bookingId, propertyTitle: booking.room.property.title });
    // L'hôte est prévenu par PayoutsService (versement mis en file, puis versement envoyé).
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
    for (const collaborator of booking.room.property.collaborators.filter((c) => can(c.role, 'bookings.manage'))) {
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
    const isCollaborator = booking.room.property.collaborators.some((c) => c.userId === userId && can(c.role, 'bookings.manage'));
    if (!isTraveler && !isCollaborator) {
      throw new ForbiddenException("Vous n'êtes pas partie prenante de cette réservation.");
    }
  }

  /** Une offre restée sans réponse plus de 2 h ferme la demande, avant toute autre action. */
  private async assertNotExpired(booking: { id: string; offers: { createdAt: Date }[] }) {
    const current = booking.offers[0];
    if (current && isExpired(current.createdAt)) {
      await this.expireStale({ bookingId: booking.id });
      throw new ConflictException('Cette demande a expiré : personne n’a répondu dans les 2 heures.');
    }
  }

  /**
   * Annule les demandes dont l'offre en attente a plus de 2 h (pas de tâche planifiée : on nettoie
   * à chaque lecture ou action concernée) et prévient les deux parties.
   */
  private async expireStale(scope: { travelerId?: string; propertyId?: string; bookingId?: string }) {
    await this.forfeitUnpaidBalances(scope);
    const cutoff = new Date(Date.now() - RESPONSE_WINDOW_MS);
    const stale = await this.prisma.booking.findMany({
      where: {
        status: 'NEGOTIATING',
        ...(scope.travelerId ? { travelerId: scope.travelerId } : {}),
        ...(scope.propertyId ? { room: { propertyId: scope.propertyId } } : {}),
        ...(scope.bookingId ? { id: scope.bookingId } : {}),
        offers: { some: { status: 'PENDING', createdAt: { lte: cutoff } } },
      },
      include: { room: { include: { property: { include: { collaborators: true } } } } },
      take: 100,
    });
    for (const booking of stale) {
      const closed = await this.prisma.$transaction(async (tx) => {
        await tx.priceOffer.updateMany({ where: { bookingId: booking.id, status: 'PENDING' }, data: { status: 'REJECTED' } });
        return tx.booking.updateMany({ where: { id: booking.id, status: 'NEGOTIATING' }, data: { status: 'CANCELLED' } });
      });
      if (closed.count === 0) continue;
      const title = booking.room.property.title;
      await this.notifications.notify(booking.travelerId, 'BOOKING_EXPIRED', { bookingId: booking.id, audience: 'traveler', propertyTitle: title });
      for (const c of booking.room.property.collaborators.filter((x) => can(x.role, 'bookings.manage'))) {
        await this.notifications.notify(c.userId, 'BOOKING_EXPIRED', { bookingId: booking.id, audience: 'host', propertyTitle: title });
      }
    }
  }

  /**
   * Salle de fêtes : solde non payé à l'échéance → la réservation est annulée et l'acompte reste à l'hôte
   * (règle acceptée au départ). Comme pour les demandes expirées, pas de tâche planifiée : on traite à la
   * lecture ou à l'action concernée. L'acompte entre dans la file « À verser » de la finance.
   */
  private async forfeitUnpaidBalances(scope: { travelerId?: string; propertyId?: string; bookingId?: string }) {
    const overdue = await this.prisma.booking.findMany({
      where: {
        status: 'DEPOSIT_PAID',
        balanceDueAt: { lte: new Date() },
        ...(scope.travelerId ? { travelerId: scope.travelerId } : {}),
        ...(scope.propertyId ? { room: { propertyId: scope.propertyId } } : {}),
        ...(scope.bookingId ? { id: scope.bookingId } : {}),
      },
      include: { escrowVault: true, room: { include: { property: { include: { collaborators: true } } } } },
      take: 50,
    });
    for (const booking of overdue) {
      const escrow = booking.escrowVault;
      if (!escrow || escrow.depositAmount == null) continue;
      const amounts = forfeitedAmounts(escrow);
      const closed = await this.prisma.$transaction(async (tx) => {
        const res = await tx.booking.updateMany({ where: { id: booking.id, status: 'DEPOSIT_PAID' }, data: { status: 'CANCELLED' } });
        if (res.count === 0) return false; // le solde vient d'être payé : rien à faire
        await tx.escrowVault.update({ where: { id: escrow.id }, data: amounts });
        return true;
      });
      if (!closed) continue;
      try {
        await this.paymentsService.releaseEscrow(booking.id);
      } catch {
        // La mise en file pourra être refaite : l'acompte reste HELD_IN_ESCROW en attendant.
      }
      const title = booking.room.property.title;
      const amount = amounts.amountHeld;
      await this.notifications.notify(booking.travelerId, 'BALANCE_FORFEITED', { bookingId: booking.id, audience: 'traveler', propertyTitle: title, amount });
      for (const c of booking.room.property.collaborators.filter((x) => can(x.role, 'bookings.manage'))) {
        await this.notifications.notify(c.userId, 'BALANCE_FORFEITED', { bookingId: booking.id, audience: 'host', propertyTitle: title, amount });
      }
    }
  }

  private assertNegotiating(booking: { status: string }) {
    if (booking.status !== 'NEGOTIATING') {
      throw new ConflictException('Cette négociation est terminée.');
    }
  }

  /**
   * Vérifie qu'il reste au moins une unité du type de chambre sur toutes les nuits du séjour.
   * Un type à 1 unité garde exactement l'ancien comportement (pas de chevauchement).
   */
  private async assertUnitAvailable(
    roomId: string,
    checkInDate: Date,
    checkOutDate: Date,
    excludeBookingId?: string,
    db: Pick<PrismaService, 'booking' | 'room' | 'roomBlock'> = this.prisma,
    units = 1,
    nap?: { startHour: number; hours: number },
  ) {
    const room = await db.room.findUnique({ where: { id: roomId }, select: { unitCount: true } });
    // Dates fermées par l'hôte : elles comptent comme des séjours (voir rooms/blocks.utils.ts).
    const blocks = await db.roomBlock.findMany({
      where: { roomId, startDate: { lt: nap ? new Date(checkInDate.getTime() + 24 * 3_600_000) : checkOutDate }, endDate: { gt: checkInDate } },
      select: { startDate: true, endDate: true, units: true },
    });
    const unitCount = room?.unitCount ?? 1;
    // Sieste : contrôle heure par heure contre les séjours de la veille, du jour et du lendemain, et les autres siestes.
    if (nap) {
      const around = await db.booking.findMany({
        where: {
          roomId,
          id: excludeBookingId ? { not: excludeBookingId } : undefined,
          status: { in: [...BLOCKING_STATUSES] },
          checkInDate: { lte: checkInDate },
          checkOutDate: { gte: checkInDate },
        },
        select: { checkInDate: true, checkOutDate: true, units: true, napStartHour: true, napHours: true },
      });
      if (!napFits(unitCount - blockedUnitsOn(blocks, checkInDate, unitCount), around, checkInDate, nap.startHour, nap.hours)) {
        throw new ConflictException("Cette chambre n'est pas libre sur ce créneau. Choisissez une autre heure ou une autre chambre.");
      }
      return;
    }
    const staysRaw = await db.booking.findMany({
      where: {
        roomId,
        id: excludeBookingId ? { not: excludeBookingId } : undefined,
        status: { in: [...BLOCKING_STATUSES] },
        napStartHour: null,
        checkInDate: { lt: checkOutDate },
        checkOutDate: { gt: checkInDate },
      },
      select: { checkInDate: true, checkOutDate: true, units: true, napStartHour: true },
    });
    const stays = [...staysRaw.filter((b) => b.napStartHour == null), ...blocks.map((b) => blockAsStay(b, unitCount))];
    const left = unitsLeft(unitCount, stays, checkInDate, checkOutDate);
    if (left < units) {
      throw new ConflictException(
        left < 1
          ? 'Ces dates ne sont plus disponibles pour cette chambre.'
          : `Il ne reste que ${left} chambre${left > 1 ? 's' : ''} de ce type sur ces dates.`,
      );
    }
    // Les siestes déjà réservées pendant ces jours occupent aussi des chambres, heure par heure.
    const napsRaw = await db.booking.findMany({
      where: {
        roomId,
        id: excludeBookingId ? { not: excludeBookingId } : undefined,
        status: { in: [...BLOCKING_STATUSES] },
        napStartHour: { not: null },
        checkInDate: { gte: checkInDate, lte: checkOutDate },
      },
      select: { checkInDate: true, checkOutDate: true, units: true, napStartHour: true, napHours: true },
    });
    const naps = napsRaw.filter((b) => b.napStartHour != null);
    if (naps.length > 0 && !stayFitsHourly(room?.unitCount ?? 1, [...stays, ...naps], checkInDate, checkOutDate, units)) {
      throw new ConflictException('Une sieste déjà réservée occupe cette chambre pendant ce séjour. Choisissez d\'autres dates.');
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

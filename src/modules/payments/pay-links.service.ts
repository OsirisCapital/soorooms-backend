/**
 * Lien de paiement pour un proche (diaspora). Le voyageur de la réservation génère un lien secret ;
 * la personne qui le reçoit — souvent à l'étranger, sans compte SòôRooms — voit un résumé minimal de la
 * réservation et paie le montant attendu. Le séquestre, le reçu et la réservation restent ceux du voyageur.
 *
 * Sécurité : le jeton est aléatoire (256 bits) et ne donne accès qu'à deux choses — lire le résumé et payer
 * CETTE réservation. Le voyageur peut le révoquer ; il cesse aussi de fonctionner dès que plus rien n'est à payer.
 */
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { PayLinkInitiateDto } from './dto/pay-link.dto.js';
import { PaymentsService } from './payments.service.js';

const PAYABLE = ['PENDING_PAYMENT', 'DEPOSIT_PAID'];

@Injectable()
export class PayLinksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
  ) {}

  /** Crée (ou renvoie) le lien du voyageur. */
  async create(bookingId: string, userId: string) {
    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking || booking.travelerId !== userId) throw new NotFoundException('Réservation introuvable.');
    if (!PAYABLE.includes(booking.status) || booking.totalPrice == null) {
      throw new ConflictException("Cette réservation n'attend pas de paiement pour le moment.");
    }
    if (booking.payToken) return { token: booking.payToken };
    const token = randomBytes(32).toString('hex');
    await this.prisma.booking.update({ where: { id: bookingId }, data: { payToken: token } });
    return { token };
  }

  /** Révoque le lien : l'ancien jeton ne marche plus. */
  async revoke(bookingId: string, userId: string) {
    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId }, select: { travelerId: true } });
    if (!booking || booking.travelerId !== userId) throw new NotFoundException('Réservation introuvable.');
    await this.prisma.booking.update({ where: { id: bookingId }, data: { payToken: null } });
    return { revoked: true };
  }

  /** Résumé public : le strict nécessaire pour reconnaître la réservation et savoir combien payer. */
  async summary(token: string) {
    const booking = await this.byToken(token);
    const stage = await this.payments.quote(booking);
    return {
      propertyTitle: booking.room.property.title,
      city: booking.room.property.city,
      roomName: booking.room.name,
      checkInDate: booking.checkInDate,
      checkOutDate: booking.checkOutDate,
      travelerFirstName: booking.traveler.fullName.split(' ')[0],
      status: booking.status,
      payable: PAYABLE.includes(booking.status) && booking.totalPrice != null,
      stage: stage?.kind ?? null,
      amount: stage?.amount ?? null,
      currency: 'XAF',
    };
  }

  async initiate(token: string, dto: PayLinkInitiateDto) {
    const booking = await this.byToken(token);
    const { paymentUrl, stage, amount } = await this.payments.startPayment(
      booking,
      { name: dto.payerName.trim(), email: dto.payerEmail.trim().toLowerCase(), phone: dto.payerPhone?.replace(/\s+/g, '') || undefined },
      `/payer/${token}`,
    );
    return { paymentUrl, stage, amount };
  }

  async verify(token: string, reference: string) {
    const booking = await this.byToken(token);
    return this.payments.verifyBooking(booking, reference);
  }

  private async byToken(token: string) {
    // Le jeton est aléatoire ; une longueur fantaisiste est refusée avant même d'interroger la base.
    if (!/^[0-9a-f]{64}$/.test(token)) throw new NotFoundException('Lien de paiement invalide ou expiré.');
    const booking = await this.prisma.booking.findUnique({
      where: { payToken: token },
      include: { room: { include: { property: true } }, traveler: { select: { fullName: true } } },
    });
    if (!booking) throw new NotFoundException('Lien de paiement invalide ou expiré.');
    if (booking.status === 'CANCELLED') throw new ForbiddenException('Cette réservation est annulée.');
    return booking;
  }
}

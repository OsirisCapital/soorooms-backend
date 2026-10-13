/**
 * Avis après séjour. Règles : seul le voyageur d'une réservation TERMINÉE peut noter, une seule fois ;
 * l'avis est public (prénom + initiale), l'hôte peut y répondre publiquement. Un avis ne se modifie pas
 * et ne se supprime pas : c'est ce qui le rend crédible. En cas d'abus, c'est l'équipe qui intervient.
 */
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { userIdsWith } from '../../common/utils/collaborator-access.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type { CreateReviewDto } from './dto/review.dto.js';
import { averageRating, publicAuthorName, ratingDistribution } from './reviews.utils.js';

const PAGE = 20;

@Injectable()
export class ReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Où en est la personne pour cette réservation : avis déjà laissé, ou peut-elle en laisser un ? */
  async forBooking(bookingId: string, userId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, travelerId: true, status: true, review: { select: { id: true, rating: true, comment: true, hostReply: true, createdAt: true } } },
    });
    if (!booking) throw new NotFoundException('Réservation introuvable.');
    if (booking.travelerId !== userId) throw new ForbiddenException('Seul le voyageur de cette réservation peut la noter.');
    return { review: booking.review ?? null, canReview: booking.status === 'COMPLETED' && !booking.review };
  }

  async create(bookingId: string, userId: string, dto: CreateReviewDto) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        travelerId: true,
        status: true,
        review: { select: { id: true } },
        room: { select: { property: { select: { id: true, title: true, collaborators: { select: { userId: true, role: true } } } } } },
      },
    });
    if (!booking) throw new NotFoundException('Réservation introuvable.');
    if (booking.travelerId !== userId) throw new ForbiddenException('Seul le voyageur de cette réservation peut la noter.');
    if (booking.status !== 'COMPLETED') throw new ConflictException('Vous pourrez noter ce logement une fois le séjour terminé.');
    if (booking.review) throw new ConflictException('Vous avez déjà laissé un avis pour cette réservation.');

    let review;
    try {
      review = await this.prisma.review.create({
        data: { bookingId, authorId: userId, rating: dto.rating, comment: dto.comment?.trim() || null },
        select: { id: true, rating: true, comment: true, hostReply: true, createdAt: true },
      });
    } catch (error) {
      // Deux envois simultanés : l'index unique n'en laisse passer qu'un.
      if (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002') {
        throw new ConflictException('Vous avez déjà laissé un avis pour cette réservation.');
      }
      throw error;
    }

    const property = booking.room.property;
    for (const hostId of userIdsWith(property.collaborators, 'bookings.manage')) {
      await this.notifications.notify(hostId, 'REVIEW_RECEIVED', { propertyId: property.id, propertyTitle: property.title, rating: dto.rating });
    }
    return review;
  }

  /** Les avis de la personne connectée, avec le logement noté. */
  async mine(userId: string) {
    const rows = await this.prisma.review.findMany({
      where: { authorId: userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        bookingId: true,
        rating: true,
        comment: true,
        hostReply: true,
        createdAt: true,
        booking: { select: { room: { select: { property: { select: { id: true, title: true, city: true } } } } } },
      },
    });
    return rows.map(({ booking, ...r }) => ({ ...r, property: booking.room.property }));
  }

  /** Avis publics d'un logement : moyenne, répartition et les plus récents. `before` (date ISO) charge la suite. */
  async forProperty(propertyId: string, before?: string) {
    const where = { booking: { room: { propertyId } } };
    const cursor = before ? new Date(before) : null;
    const [all, page] = await Promise.all([
      this.prisma.review.findMany({ where, select: { rating: true } }),
      this.prisma.review.findMany({
        where: { ...where, ...(cursor && !Number.isNaN(cursor.getTime()) ? { createdAt: { lt: cursor } } : {}) },
        orderBy: { createdAt: 'desc' },
        take: PAGE + 1,
        select: { id: true, rating: true, comment: true, hostReply: true, hostRepliedAt: true, createdAt: true, author: { select: { fullName: true } } },
      }),
    ]);
    const ratings = all.map((r) => r.rating);
    const hasMore = page.length > PAGE;
    return {
      average: averageRating(ratings),
      count: ratings.length,
      distribution: ratingDistribution(ratings),
      hasMore,
      items: (hasMore ? page.slice(0, PAGE) : page).map(({ author, ...r }) => ({ ...r, authorName: publicAuthorName(author.fullName) })),
    };
  }

  /** Réponse publique de l'hôte (le contrôleur a déjà vérifié le droit « réservations » sur ce logement). */
  async reply(propertyId: string, reviewId: string, reply: string) {
    const review = await this.prisma.review.findFirst({
      where: { id: reviewId, booking: { room: { propertyId } } },
      select: { id: true, authorId: true, booking: { select: { room: { select: { property: { select: { title: true } } } } } } },
    });
    if (!review) throw new NotFoundException('Avis introuvable.');
    const updated = await this.prisma.review.update({
      where: { id: reviewId },
      data: { hostReply: reply.trim(), hostRepliedAt: new Date() },
      select: { id: true, hostReply: true, hostRepliedAt: true },
    });
    await this.notifications.notify(review.authorId, 'REVIEW_REPLIED', { propertyTitle: review.booking.room.property.title });
    return updated;
  }
}

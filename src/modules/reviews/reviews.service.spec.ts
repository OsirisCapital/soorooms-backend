import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import { ReviewsService } from './reviews.service.js';

const property = { id: 'p1', title: 'Villa', collaborators: [{ userId: 'h1', role: 'MANAGER' }, { userId: 'acc', role: 'ACCOUNTANT' }] };
const booking = (over: Record<string, unknown> = {}) => ({ id: 'b1', travelerId: 't1', status: 'COMPLETED', review: null, room: { property }, ...over });

function make(over: { booking?: unknown; createError?: unknown } = {}) {
  const create = over.createError ? vi.fn().mockRejectedValue(over.createError) : vi.fn().mockResolvedValue({ id: 'r1', rating: 5, comment: 'Top', hostReply: null, createdAt: new Date() });
  const prisma = {
    booking: { findUnique: vi.fn().mockResolvedValue(over.booking === undefined ? booking() : over.booking) },
    review: { create, findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn(), update: vi.fn() },
  };
  const notify = vi.fn().mockResolvedValue(true);
  return { service: new ReviewsService(prisma as unknown as PrismaService, { notify } as unknown as NotificationsService), prisma, notify };
}

describe('ReviewsService.create', () => {
  it('enregistre l’avis et prévient ceux qui gèrent les réservations (pas le comptable)', async () => {
    const { service, prisma, notify } = make();
    await service.create('b1', 't1', { rating: 5, comment: '  Top  ' });
    expect(prisma.review.create).toHaveBeenCalledWith(expect.objectContaining({ data: { bookingId: 'b1', authorId: 't1', rating: 5, comment: 'Top' } }));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('h1', 'REVIEW_RECEIVED', { propertyId: 'p1', propertyTitle: 'Villa', rating: 5 });
  });

  it('refuse un autre voyageur, un séjour non terminé et un second avis', async () => {
    await expect(make().service.create('b1', 'intrus', { rating: 4 })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(make({ booking: booking({ status: 'CONFIRMED_ESCROW' }) }).service.create('b1', 't1', { rating: 4 })).rejects.toBeInstanceOf(ConflictException);
    await expect(make({ booking: booking({ review: { id: 'r0' } }) }).service.create('b1', 't1', { rating: 4 })).rejects.toBeInstanceOf(ConflictException);
    await expect(make({ booking: null }).service.create('b1', 't1', { rating: 4 })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('traduit un doublon simultané (index unique) en conflit clair', async () => {
    const { service, notify } = make({ createError: { code: 'P2002' } });
    await expect(service.create('b1', 't1', { rating: 4 })).rejects.toBeInstanceOf(ConflictException);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('ReviewsService.forBooking', () => {
  it('dit si le voyageur peut noter', async () => {
    expect(await make().service.forBooking('b1', 't1')).toEqual({ review: null, canReview: true });
    expect(await make({ booking: booking({ status: 'CONFIRMED_ESCROW' }) }).service.forBooking('b1', 't1')).toEqual({ review: null, canReview: false });
    const done = await make({ booking: booking({ review: { id: 'r0', rating: 4 } }) }).service.forBooking('b1', 't1');
    expect(done.canReview).toBe(false);
  });
  it('refuse un autre utilisateur', async () => {
    await expect(make().service.forBooking('b1', 'intrus')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('ReviewsService.forProperty', () => {
  it("calcule la moyenne, masque le nom complet et pagine", async () => {
    const { service, prisma } = make();
    const date = (d: number) => new Date(2026, 9, d);
    prisma.review.findMany
      .mockResolvedValueOnce([{ rating: 5 }, { rating: 4 }, { rating: 4 }])
      .mockResolvedValueOnce([{ id: 'r1', rating: 5, comment: 'Super', hostReply: null, hostRepliedAt: null, createdAt: date(2), author: { fullName: 'Marie Kouam' } }]);
    const out = await service.forProperty('p1');
    expect(out.average).toBe(4.3);
    expect(out.count).toBe(3);
    expect(out.hasMore).toBe(false);
    expect(out.items[0].authorName).toBe('Marie K.');
    expect(JSON.stringify(out)).not.toContain('Kouam');
  });
});

describe('ReviewsService.reply', () => {
  it("n'autorise que les avis du logement concerné et prévient le voyageur", async () => {
    const { service, prisma, notify } = make();
    prisma.review.findFirst.mockResolvedValue({ id: 'r1', authorId: 't1', booking: { room: { property: { title: 'Villa' } } } });
    prisma.review.update.mockResolvedValue({ id: 'r1', hostReply: 'Merci !', hostRepliedAt: new Date() });
    await service.reply('p1', 'r1', ' Merci ! ');
    expect(prisma.review.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'r1', booking: { room: { propertyId: 'p1' } } } }));
    expect(prisma.review.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ hostReply: 'Merci !' }) }));
    expect(notify).toHaveBeenCalledWith('t1', 'REVIEW_REPLIED', { propertyTitle: 'Villa' });
  });
  it('refuse un avis d’un autre logement', async () => {
    const { service, prisma } = make();
    prisma.review.findFirst.mockResolvedValue(null);
    await expect(service.reply('p1', 'r9', 'Merci')).rejects.toBeInstanceOf(NotFoundException);
  });
});

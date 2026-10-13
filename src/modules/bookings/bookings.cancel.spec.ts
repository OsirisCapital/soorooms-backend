import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import type { PaymentsService } from '../payments/payments.service.js';
import { BookingsService } from './bookings.service.js';

const DAY = 24 * 3_600_000;
const inDays = (n: number) => new Date(Math.floor((Date.now() + n * DAY) / DAY) * DAY);

function setup(o: { status?: string; days?: number; type?: string; nap?: number | null; paid?: number; host?: boolean; claimCount?: number } = {}) {
  const paid = o.paid ?? 105_000;
  const booking = {
    id: 'b1', travelerId: 't1', status: o.status ?? 'CONFIRMED_ESCROW', currency: 'XAF',
    checkInDate: inDays(o.days ?? 10), napStartHour: o.nap ?? null, offers: [],
    room: { property: { title: 'Villa', propertyType: o.type ?? 'HOTEL', collaborators: [{ userId: 'h1', role: 'MANAGER' }] } },
  };
  const escrow = { id: 'e1', amountHeld: 105_000, travelerFee: 5_000, hostPayout: 90_000, depositAmount: null, transactions: paid > 0 ? [{ amount: paid }] : [] };
  const tx = {
    booking: { updateMany: vi.fn().mockResolvedValue({ count: o.claimCount ?? 1 }) },
    auditLog: { create: vi.fn() },
    escrowVault: { update: vi.fn() },
    refund: { create: vi.fn() },
  };
  const prisma = {
    booking: { findUnique: vi.fn().mockResolvedValue(booking) },
    escrowVault: { findUnique: vi.fn().mockResolvedValue(escrow) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const payments = { releaseEscrow: vi.fn().mockResolvedValue({}) };
  const notifications = { notify: vi.fn(), notifyMany: vi.fn(), notifyStaff: vi.fn() };
  const service = new BookingsService(prisma as unknown as PrismaService, payments as unknown as PaymentsService, notifications as unknown as NotificationsService);
  vi.spyOn(service, 'findOne').mockResolvedValue({} as never);
  return { service, tx, payments, notifications, who: o.host ? 'h1' : 't1' };
}
const NUMBER = { refundChannel: 'cm.mtn', refundPhone: '670 00 00 00', refundName: 'Awa Ngono' } as never;

describe('BookingsService.cancel — voyageur', () => {
  it('plus de 48 h avant : remboursement total, file finance prévenue, rien pour l’hôte', async () => {
    const c = setup({ days: 10 });
    await c.service.cancel('b1', c.who, NUMBER);
    expect(c.tx.booking.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED', cancelledById: 't1' }) }));
    expect(c.tx.refund.create).toHaveBeenCalledWith({ data: expect.objectContaining({ amount: 105_000, reason: 'TRAVELER_CANCEL', beneficiaryPhone: '+237670000000' }) });
    expect(c.tx.escrowVault.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ amountHeld: 0, hostPayout: 0 }) }));
    expect(c.payments.releaseEscrow).not.toHaveBeenCalled();
    expect(c.notifications.notifyStaff).toHaveBeenCalledWith('payouts.manage', 'REFUND_TO_SEND_STAFF', expect.objectContaining({ amount: 105_000 }));
  });

  it('moins de 48 h : 50 % remboursé, le reste est mis en versement pour l’hôte', async () => {
    const c = setup({ days: 1 });
    await c.service.cancel('b1', c.who, NUMBER);
    expect(c.tx.refund.create).toHaveBeenCalledWith({ data: expect.objectContaining({ amount: 50_000 }) });
    expect(c.tx.escrowVault.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ amountHeld: 55_000, hostPayout: 45_000, platformFee: 10_000, travelerFee: 5_000 }) }));
    expect(c.payments.releaseEscrow).toHaveBeenCalledWith('b1');
  });

  it('exige le numéro Mobile Money quand un remboursement est dû', async () => {
    const c = setup({ days: 10 });
    await expect(c.service.cancel('b1', c.who, {} as never)).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.service.cancel('b1', c.who, { ...NUMBER, refundPhone: '12345' } as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(c.tx.booking.updateMany).not.toHaveBeenCalled();
  });

  it('sieste à moins de 3 h : rien rendu, pas de numéro demandé, tout reste côté hôte', async () => {
    const start = new Date(Date.now() + 2 * 3_600_000);
    const hourWat = (start.getUTCHours() + 1) % 24;
    const c = setup({ days: 0, nap: hourWat });
    // on force la date d'arrivée au jour calendaire (WAT) de la sieste
    const date = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + (start.getUTCHours() + 1 >= 24 ? 1 : 0)));
    (c.service as never as { prisma: { booking: { findUnique: ReturnType<typeof vi.fn> } } }).prisma.booking.findUnique.mockResolvedValue({
      id: 'b1', travelerId: 't1', status: 'CONFIRMED_ESCROW', currency: 'XAF', checkInDate: date, napStartHour: hourWat, offers: [],
      room: { property: { title: 'Hôtel', propertyType: 'HOTEL', collaborators: [{ userId: 'h1', role: 'MANAGER' }] } },
    });
    await c.service.cancel('b1', 't1', {} as never);
    expect(c.tx.refund.create).not.toHaveBeenCalled();
    expect(c.payments.releaseEscrow).toHaveBeenCalled();
  });

  it('refuse après l’heure d’arrivée', async () => {
    const c = setup({ days: -2 });
    await expect(c.service.cancel('b1', c.who, NUMBER)).rejects.toBeInstanceOf(ConflictException);
    expect(c.tx.booking.updateMany).not.toHaveBeenCalled();
  });

  it('refuse une réservation terminée, en litige ou déjà annulée', async () => {
    for (const status of ['COMPLETED', 'DISPUTED', 'CANCELLED']) {
      const c = setup({ status });
      await expect(c.service.cancel('b1', c.who, NUMBER)).rejects.toBeInstanceOf(ConflictException);
    }
  });

  it('avant paiement : annulation simple, aucun argent', async () => {
    const c = setup({ status: 'PENDING_PAYMENT', paid: 0 });
    await c.service.cancel('b1', c.who, {} as never);
    expect(c.tx.refund.create).not.toHaveBeenCalled();
    expect(c.payments.releaseEscrow).not.toHaveBeenCalled();
  });

  it('deux annulations simultanées : la seconde est refusée', async () => {
    const c = setup({ claimCount: 0 });
    await expect(c.service.cancel('b1', c.who, NUMBER)).rejects.toBeInstanceOf(ConflictException);
    expect(c.tx.refund.create).not.toHaveBeenCalled();
  });

  it('un étranger à la réservation ne peut pas annuler', async () => {
    const c = setup();
    await expect(c.service.cancel('b1', 'intrus', NUMBER)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('BookingsService.cancel — hôte', () => {
  it('rend tout au voyageur (même la veille), sans exiger de numéro', async () => {
    const c = setup({ days: 0, host: true });
    await c.service.cancel('b1', c.who, {} as never);
    expect(c.tx.refund.create).toHaveBeenCalledWith({ data: expect.objectContaining({ amount: 105_000, reason: 'HOST_CANCEL', beneficiaryPhone: null }) });
    expect(c.payments.releaseEscrow).not.toHaveBeenCalled();
  });
});

describe('BookingsService.previewCancellation', () => {
  it('annonce le montant remboursé sans rien modifier', async () => {
    const c = setup({ days: 1 });
    const p = await c.service.previewCancellation('b1', c.who);
    expect(p).toMatchObject({ canCancel: true, refund: 50_000, retained: 55_000, percent: 48, needsRefundNumber: true });
    expect(c.tx.booking.updateMany).not.toHaveBeenCalled();
  });
  it('explique pourquoi on ne peut plus annuler', async () => {
    const p = await setup({ days: -1 }).service.previewCancellation('b1', 't1');
    expect(p).toMatchObject({ canCancel: false });
  });
});

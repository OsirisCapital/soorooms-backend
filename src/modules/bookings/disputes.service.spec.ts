import { BadRequestException, ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { DisputesService } from './disputes.service.js';
import { splitForRefund } from './refund-policy.js';

function setup(o: { status?: string; payout?: boolean; paid?: number; claim?: number } = {}) {
  const booking = {
    id: 'b1', status: o.status ?? 'DISPUTED', travelerId: 't1',
    room: { property: { title: 'Villa', collaborators: [{ userId: 'h1', role: 'MANAGER' }] } },
    escrowVault: {
      id: 'e1', status: 'HELD_IN_ESCROW', amountHeld: 105_000, hostPayout: 90_000, travelerFee: 5_000,
      payout: o.payout ? { id: 'p' } : null, refund: null,
      transactions: [{ amount: o.paid ?? 105_000 }],
    },
  };
  const tx = {
    booking: { updateMany: vi.fn().mockResolvedValue({ count: o.claim ?? 1 }) },
    auditLog: { create: vi.fn() },
    escrowVault: { update: vi.fn() },
    refund: { create: vi.fn() },
  };
  const prisma = { booking: { findUnique: vi.fn().mockResolvedValue(booking) }, $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const payments = { releaseEscrow: vi.fn().mockResolvedValue({}) };
  const notifications = { notify: vi.fn(), notifyStaff: vi.fn() };
  const loyalty = { awardForCompletedBooking: vi.fn() };
  const partners = { accrueForBooking: vi.fn() };
  const service = new DisputesService(prisma as never, payments as never, notifications as never, loyalty as never, partners as never);
  return { service, tx, payments, notifications, loyalty, partners };
}
const NOTE = 'Photos reçues, le logement ne correspond pas.';

describe('splitForRefund', () => {
  it('répartit le reste au prorata, sans dépasser', () => {
    expect(splitForRefund({ paid: 105_000, hostPayout: 90_000, travelerFee: 5_000, refund: 52_500 })).toEqual({ retained: 52_500, hostPayout: 45_000, travelerFeeKept: 2_500 });
    expect(splitForRefund({ paid: 105_000, hostPayout: 90_000, travelerFee: 5_000, refund: 105_000 })).toEqual({ retained: 0, hostPayout: 0, travelerFeeKept: 0 });
  });
});

describe('DisputesService.resolve', () => {
  it('remboursement total : réservation annulée, tout part en remboursement, rien pour l’hôte', async () => {
    const c = setup();
    await c.service.resolve('b1', 'adm', { decision: 'REFUND_FULL', note: NOTE });
    expect(c.tx.booking.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED' }) }));
    expect(c.tx.refund.create).toHaveBeenCalledWith({ data: expect.objectContaining({ amount: 105_000, reason: 'DISPUTE' }) });
    expect(c.payments.releaseEscrow).not.toHaveBeenCalled();
    expect(c.notifications.notify).toHaveBeenCalledWith('t1', 'DISPUTE_RESOLVED', expect.objectContaining({ audience: 'traveler', decision: 'REFUND_FULL' }));
    expect(c.notifications.notify).toHaveBeenCalledWith('h1', 'DISPUTE_RESOLVED', expect.objectContaining({ audience: 'host' }));
    expect(c.notifications.notifyStaff).toHaveBeenCalledWith('payouts.manage', 'REFUND_TO_SEND_STAFF', expect.objectContaining({ amount: 105_000 }));
  });

  it('remboursement partiel : une part rendue, le reste mis en versement pour l’hôte', async () => {
    const c = setup();
    await c.service.resolve('b1', 'adm', { decision: 'REFUND_PARTIAL', refundAmount: 52_500, note: NOTE });
    expect(c.tx.refund.create).toHaveBeenCalledWith({ data: expect.objectContaining({ amount: 52_500 }) });
    expect(c.tx.escrowVault.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ amountHeld: 52_500, hostPayout: 45_000 }) }));
    expect(c.payments.releaseEscrow).toHaveBeenCalledWith('b1');
  });

  it('remboursement partiel : montant obligatoire et strictement inférieur à la somme payée', async () => {
    for (const refundAmount of [undefined, 105_000, 200_000]) {
      const c = setup();
      await expect(c.service.resolve('b1', 'adm', { decision: 'REFUND_PARTIAL', refundAmount, note: NOTE })).rejects.toBeInstanceOf(BadRequestException);
      expect(c.tx.booking.updateMany).not.toHaveBeenCalled();
    }
  });

  it('payer l’hôte : réservation terminée, versement en file, aucun remboursement, points de fidélité', async () => {
    const c = setup();
    await c.service.resolve('b1', 'adm', { decision: 'PAY_HOST', note: NOTE });
    expect(c.tx.booking.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'COMPLETED' } }));
    expect(c.tx.refund.create).not.toHaveBeenCalled();
    expect(c.payments.releaseEscrow).toHaveBeenCalledWith('b1');
    expect(c.loyalty.awardForCompletedBooking).toHaveBeenCalledWith('b1');
    expect(c.partners.accrueForBooking).toHaveBeenCalledWith('b1');
  });

  it('un remboursement partiel ouvre aussi le calcul de la commission partenaire (sur le revenu conservé)', async () => {
    const c = setup();
    await c.service.resolve('b1', 'adm', { decision: 'REFUND_PARTIAL', refundAmount: 5000, note: NOTE });
    expect(c.partners.accrueForBooking).toHaveBeenCalledWith('b1');
  });

  it('refuse un litige déjà tranché ou des fonds déjà traités', async () => {
    await expect(setup({ status: 'CANCELLED' }).service.resolve('b1', 'adm', { decision: 'PAY_HOST', note: NOTE })).rejects.toBeInstanceOf(ConflictException);
    await expect(setup({ payout: true }).service.resolve('b1', 'adm', { decision: 'REFUND_FULL', note: NOTE })).rejects.toBeInstanceOf(ConflictException);
  });

  it('deux décisions simultanées : la seconde est refusée sans rien créer', async () => {
    const c = setup({ claim: 0 });
    await expect(c.service.resolve('b1', 'adm', { decision: 'REFUND_FULL', note: NOTE })).rejects.toBeInstanceOf(ConflictException);
    expect(c.tx.refund.create).not.toHaveBeenCalled();
  });
});

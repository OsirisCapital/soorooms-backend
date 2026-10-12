import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import type { PaymentsService } from '../payments/payments.service.js';
import { BookingsService } from './bookings.service.js';

const escrow = { id: 'e1', amountHeld: 309000, hostPayout: 285000, travelerFee: 9000, depositAmount: 92700 };
const overdue = {
  id: 'b1', travelerId: 't1', escrowVault: escrow,
  room: { property: { title: 'Salle Prestige', collaborators: [{ userId: 'h1', role: 'MANAGER' }] } },
};

function setup(claimed = 1) {
  const tx = { booking: { updateMany: vi.fn().mockResolvedValue({ count: claimed }) }, escrowVault: { update: vi.fn() } };
  const prisma = {
    booking: { findMany: vi.fn().mockImplementation(async (a: { where: { status?: unknown } }) => (a.where.status === 'DEPOSIT_PAID' ? [overdue] : [])), findUnique: vi.fn() },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const payments = { releaseEscrow: vi.fn().mockResolvedValue({}) };
  const notifications = { notify: vi.fn(), notifyMany: vi.fn(), notifyStaff: vi.fn() };
  const service = new BookingsService(prisma as unknown as PrismaService, payments as unknown as PaymentsService, notifications as unknown as NotificationsService);
  return { service, tx, payments, notifications, prisma };
}

describe('solde non payé à l’échéance', () => {
  it('annule, réduit le séquestre à l’acompte, le met en file de versement et prévient les deux parties', async () => {
    const { service, tx, payments, notifications } = setup();
    await (service as unknown as { forfeitUnpaidBalances: (s: object) => Promise<void> }).forfeitUnpaidBalances({});
    expect(tx.booking.updateMany).toHaveBeenCalledWith({ where: { id: 'b1', status: 'DEPOSIT_PAID' }, data: { status: 'CANCELLED' } });
    const data = tx.escrowVault.update.mock.calls[0][0].data;
    expect(data.amountHeld).toBe(92700);
    expect(data.hostPayout + data.platformFee).toBe(92700);
    expect(payments.releaseEscrow).toHaveBeenCalledWith('b1');
    expect(notifications.notify).toHaveBeenCalledWith('t1', 'BALANCE_FORFEITED', expect.objectContaining({ audience: 'traveler', amount: 92700 }));
    expect(notifications.notify).toHaveBeenCalledWith('h1', 'BALANCE_FORFEITED', expect.objectContaining({ audience: 'host' }));
  });

  it('ne fait rien si le solde vient d’être payé entre-temps', async () => {
    const { service, tx, payments, notifications } = setup(0);
    await (service as unknown as { forfeitUnpaidBalances: (s: object) => Promise<void> }).forfeitUnpaidBalances({});
    expect(tx.escrowVault.update).not.toHaveBeenCalled();
    expect(payments.releaseEscrow).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
  });
});

describe('reçu en deux temps', () => {
  const booking = (txs: number[], status = 'DEPOSIT_PAID') => ({
    id: '3f9a1c2b-0000-4000-8000-000000000000', travelerId: 't1', traveler: { fullName: 'M' }, currency: 'XAF', status,
    checkInDate: new Date('2027-03-06'), checkOutDate: new Date('2027-03-07'), balanceDueAt: new Date('2027-02-27'),
    room: { name: 'Salle', property: { title: 'P', city: 'Douala', quarter: 'Akwa' } },
    escrowVault: { amountHeld: 309000, travelerFee: 9000, travelerFeePercent: 3, status: 'HELD_IN_ESCROW', depositAmount: 92700,
      transactions: txs.map((amount) => ({ amount, paymentMethod: 'MTN_MOMO', createdAt: new Date('2026-10-12') })) },
  });
  const make = (b: unknown) => new BookingsService({ booking: { findUnique: vi.fn().mockResolvedValue(b) } } as unknown as PrismaService, {} as PaymentsService, {} as NotificationsService);

  it('acompte seul : prix complet, payé à ce jour, solde et échéance', async () => {
    const r = await make(booking([92700])).getReceipt('b', 't1');
    expect(r).toMatchObject({ stayPrice: 300000, totalPaid: 92700, balanceDue: 216300, balanceDueAt: new Date('2027-02-27') });
  });
  it('tout payé : plus de solde', async () => {
    const r = await make(booking([92700, 216300], 'CONFIRMED_ESCROW')).getReceipt('b', 't1');
    expect(r).toMatchObject({ totalPaid: 309000, balanceDue: 0, balanceDueAt: null });
  });
  it('pas de facture tant que le solde n’est pas payé', async () => {
    await expect(make(booking([92700])).issueInvoice('b', 't1', { company: 'ACME', address: 'Douala centre' })).rejects.toThrow(/solde/);
  });
});

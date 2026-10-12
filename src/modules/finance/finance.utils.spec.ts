import { describe, expect, it } from 'vitest';
import { lastDayKeys } from '../admin/stats.utils.js';
import { buildReport, type FinanceRow } from './finance.utils.js';

const NOW = new Date('2026-10-12T12:00:00Z');
const keys = lastDayKeys(30, NOW);

const row = (over: Partial<FinanceRow>): FinanceRow => ({
  escrowId: 'e', bookingId: 'b', propertyId: 'p1', propertyTitle: 'Hôtel A', city: 'Douala', roomName: 'Chambre 1',
  paidAt: new Date('2026-10-10T10:00:00Z'), closedAt: null, status: 'HELD_IN_ESCROW', bookingStatus: 'CONFIRMED_ESCROW',
  method: 'MTN_MOMO', amount: 100_000, fee: 10_000, net: 90_000, payoutStatus: null, ...over,
});

describe('buildReport', () => {
  it('base vide : tout vaut 0', () => {
    const r = buildReport([], keys, 'fee');
    expect(r.period).toMatchObject({ collected: 0, bookings: 0, commissionEarned: 0, refunded: 0 });
    expect(r.now.held).toBe(0);
    expect(r.series.collected).toHaveLength(30);
    expect(r.lines).toEqual([]);
  });

  it('sépare encaissé, séquestre, commission gagnée et remboursé', () => {
    const rows = [
      row({ escrowId: '1' }),
      row({ escrowId: '2', status: 'RELEASED_TO_HOST', closedAt: new Date('2026-10-11T08:00:00Z'), payoutStatus: 'PAID' }),
      row({ escrowId: '3', status: 'REFUNDED_TO_TRAVELER', closedAt: new Date('2026-10-11T09:00:00Z'), amount: 50_000, fee: 5_000, net: 45_000 }),
    ];
    const r = buildReport(rows, keys, 'fee');
    expect(r.period.collected).toBe(250_000);
    expect(r.period.bookings).toBe(3);
    expect(r.period.commissionEarned).toBe(10_000);
    expect(r.period.hostNetReleased).toBe(90_000);
    expect(r.period.refunded).toBe(50_000);
    expect(r.now).toMatchObject({ held: 100_000, heldFee: 10_000, heldNet: 90_000 });
    expect(r.payouts.paid).toEqual({ count: 1, amount: 90_000 });
  });

  it('compte les versements par état et isole les litiges', () => {
    const rows = [
      row({ escrowId: '1', payoutStatus: 'TO_SEND' }),
      row({ escrowId: '2', payoutStatus: 'PROCESSING' }),
      row({ escrowId: '3', payoutStatus: 'FAILED' }),
      row({ escrowId: '4', bookingStatus: 'DISPUTED' }),
    ];
    const r = buildReport(rows, keys, 'fee');
    expect(r.payouts.toSend).toEqual({ count: 1, amount: 90_000 });
    expect(r.payouts.inFlight.count).toBe(1);
    expect(r.payouts.failed.count).toBe(1);
    expect(r.now).toMatchObject({ disputedCount: 1, disputedAmount: 100_000 });
  });

  it('ignore les paiements hors période mais garde l\'argent encore en séquestre', () => {
    const old = row({ paidAt: new Date('2026-06-01T10:00:00Z') });
    const r = buildReport([old], keys, 'fee');
    expect(r.period.collected).toBe(0);
    expect(r.now.held).toBe(100_000);
  });

  it('la série réalisée suit la commission (admin) ou le net (hôte)', () => {
    const released = row({ status: 'RELEASED_TO_HOST', closedAt: new Date('2026-10-11T08:00:00Z'), payoutStatus: 'PAID' });
    expect(buildReport([released], keys, 'fee').series.settled.reduce((a, b) => a + b, 0)).toBe(10_000);
    expect(buildReport([released], keys, 'net').series.settled.reduce((a, b) => a + b, 0)).toBe(90_000);
  });

  it('classe les logements par montant et regroupe les moyens de paiement', () => {
    const rows = [
      row({ escrowId: '1', propertyId: 'p1', amount: 100_000 }),
      row({ escrowId: '2', propertyId: 'p2', propertyTitle: 'Hôtel B', amount: 300_000, method: 'ORANGE_MONEY' }),
      row({ escrowId: '3', propertyId: 'p1', amount: 50_000 }),
    ];
    const r = buildReport(rows, keys, 'fee');
    expect(r.byProperty.map((p) => p.propertyId)).toEqual(['p2', 'p1']);
    expect(r.byProperty[1]).toMatchObject({ bookings: 2, amount: 150_000 });
    expect(r.byMethod[0]).toMatchObject({ method: 'ORANGE_MONEY', amount: 300_000 });
  });
});

import { describe, expect, it } from 'vitest';
import { forfeitedAmounts, nextStage, planPayment } from './deposit.utils.js';

const day = (n: number) => new Date(Date.UTC(2027, 0, n));

describe('acompte et solde', () => {
  it('30 % maintenant, solde 7 jours avant', () => {
    const plan = planPayment({ checkInDate: day(30), now: day(1), depositPercent: 30, amountHeld: 309_000 });
    expect(plan).toEqual({ depositAmount: 92_700, balanceDueAt: day(23) });
  });
  it('paiement unique si l’événement est trop proche ou sans acompte', () => {
    expect(planPayment({ checkInDate: day(8), now: day(1), depositPercent: 30, amountHeld: 100_000 })).toBeNull();
    expect(planPayment({ checkInDate: day(30), now: day(1), depositPercent: null, amountHeld: 100_000 })).toBeNull();
  });
  it('somme attendue selon l’étape', () => {
    const escrow = { amountHeld: 300_000, depositAmount: 90_000 };
    expect(nextStage({ status: 'PENDING_PAYMENT' }, escrow)).toEqual({ kind: 'DEPOSIT', amount: 90_000 });
    expect(nextStage({ status: 'DEPOSIT_PAID' }, escrow)).toEqual({ kind: 'BALANCE', amount: 210_000 });
    expect(nextStage({ status: 'PENDING_PAYMENT' }, { amountHeld: 300_000 })).toEqual({ kind: 'FULL', amount: 300_000 });
    expect(nextStage({ status: 'CONFIRMED_ESCROW' }, escrow)).toBeNull();
  });
  it('acompte conservé : le séquestre reste équilibré', () => {
    const a = forfeitedAmounts({ amountHeld: 309_000, hostPayout: 285_000, travelerFee: 9_000, depositAmount: 92_700 });
    expect(a.amountHeld).toBe(92_700);
    expect(a.hostPayout + a.platformFee).toBe(a.amountHeld);
    expect(a.hostPayout).toBe(85_500);
  });
});

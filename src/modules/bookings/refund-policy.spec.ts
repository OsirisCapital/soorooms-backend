import { describe, expect, it } from 'vitest';
import { decideRefund, type RefundInput } from './refund-policy.js';

const DAY = 24 * 3_600_000;
// Arrivée le 20 novembre 2026 (14 h au Cameroun = 13 h UTC).
const CHECKIN = new Date('2026-11-20T00:00:00Z');
const ARRIVAL_MS = CHECKIN.getTime() + 13 * 3_600_000;
const at = (msBefore: number) => new Date(ARRIVAL_MS - msBefore);

// Séjour 100 000 + frais 5 000 = 105 000 ; l'hôte touche 90 000 (commission 10 %).
const base: RefundInput = {
  kind: 'NIGHT', checkInDate: CHECKIN, now: at(5 * DAY), actor: 'TRAVELER',
  amountHeld: 105_000, travelerFee: 5_000, hostPayout: 90_000, depositAmount: null, paid: 105_000,
};
const decide = (o: Partial<RefundInput>) => decideRefund({ ...base, ...o });
const ok = (o: Partial<RefundInput>) => {
  const d = decide(o);
  if (!d.allowed) throw new Error(d.reason);
  return d;
};

describe('séjours à la nuit', () => {
  it('plus de 48 h : tout est rendu, frais compris', () => {
    const d = ok({ now: at(49 * 3_600_000) });
    expect(d).toMatchObject({ refund: 105_000, retained: 0, hostPayout: 0, travelerFeeKept: 0, percent: 100 });
  });
  it('moins de 48 h : 50 % du séjour, frais conservés', () => {
    const d = ok({ now: at(10 * 3_600_000) });
    expect(d.refund).toBe(50_000);
    expect(d.retained).toBe(55_000);
    expect(d.hostPayout).toBe(45_000);
    expect(d.travelerFeeKept).toBe(5_000);
  });
  it('après l’arrivée : refusé', () => {
    expect(decide({ now: at(-1) }).allowed).toBe(false);
  });
});

describe('siestes', () => {
  const nap = { kind: 'NAP' as const, napStartHour: 15, amountHeld: 10_500, travelerFee: 500, hostPayout: 9_000, paid: 10_500 };
  const start = CHECKIN.getTime() + 14 * 3_600_000; // 15 h WAT
  it('au moins 3 h avant : remboursement intégral', () => {
    expect(ok({ ...nap, now: new Date(start - 3 * 3_600_000) }).refund).toBe(10_500);
  });
  it('moins de 3 h avant : rien rendu, tout reste à l’hôte et à la plateforme', () => {
    const d = ok({ ...nap, now: new Date(start - 2 * 3_600_000) });
    expect(d.refund).toBe(0);
    expect(d.hostPayout).toBe(9_000);
    expect(d.retained).toBe(10_500);
  });
});

describe('résidences', () => {
  const res = { kind: 'RESIDENCE' as const };
  it('7 jours ou plus : intégral', () => expect(ok({ ...res, now: at(8 * DAY) }).refund).toBe(105_000));
  it('moins de 7 jours : 50 %', () => expect(ok({ ...res, now: at(3 * DAY) }).refund).toBe(50_000));
});

describe('salles de fêtes', () => {
  const hall = { kind: 'HALL' as const, amountHeld: 1_050_000, travelerFee: 50_000, hostPayout: 900_000 };
  const at30 = (days: number) => new Date(CHECKIN.getTime() - days * DAY);
  it('acompte seul, 30 jours ou plus : acompte rendu en entier', () => {
    expect(ok({ ...hall, depositAmount: 315_000, paid: 315_000, now: at30(31) }).refund).toBe(315_000);
  });
  it('acompte seul, moins de 30 jours : rien rendu, l’acompte reste à l’hôte au prorata', () => {
    const d = ok({ ...hall, depositAmount: 315_000, paid: 315_000, now: at30(10) });
    expect(d.refund).toBe(0);
    expect(d.hostPayout).toBe(270_000);
  });
  it('tout payé, moins de 30 jours : acompte gardé, solde rendu à 50 %', () => {
    const d = ok({ ...hall, depositAmount: 315_000, paid: 1_050_000, now: at30(10) });
    // solde 735 000, dont séjour 700 000 → 50 % = 350 000
    expect(d.refund).toBe(350_000);
    expect(d.refund + d.retained).toBe(1_050_000);
    expect(d.hostPayout).toBeLessThanOrEqual(d.retained);
  });
  it('tout payé, 30 jours ou plus : intégral', () => {
    expect(ok({ ...hall, depositAmount: 315_000, paid: 1_050_000, now: at30(40) }).refund).toBe(1_050_000);
  });
});

describe('annulation par l’hôte', () => {
  it('rend tout, même la veille et après l’arrivée', () => {
    expect(ok({ actor: 'HOST', now: at(-5 * DAY) })).toMatchObject({ refund: 105_000, hostPayout: 0, travelerFeeKept: 0 });
  });
});

it('rien payé : rien à rendre', () => {
  expect(ok({ paid: 0 }).refund).toBe(0);
});

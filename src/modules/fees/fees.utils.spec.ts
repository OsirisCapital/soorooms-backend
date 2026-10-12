import { describe, expect, it } from 'vitest';
import { computeAmounts, ratesAt, type FeeSettings } from './fees.utils.js';

const NOW = new Date('2026-10-12T10:00:00Z');
const base: FeeSettings = { hostCommissionPercent: 10, launchHostCommissionPercent: 5, launchEndsAt: new Date('2027-01-12T00:00:00Z'), travelerFeePercent: 3 };

describe('ratesAt', () => {
  it("applique la commission de lancement tant que sa date n'est pas passée", () => {
    expect(ratesAt(base, NOW)).toEqual({ hostCommissionPercent: 5, travelerFeePercent: 3, launchActive: true });
  });
  it('revient à la commission normale après la date de fin', () => {
    expect(ratesAt(base, new Date('2027-01-12T00:00:01Z'))).toEqual({ hostCommissionPercent: 10, travelerFeePercent: 3, launchActive: false });
  });
  it("ignore l'offre si elle est incomplète", () => {
    expect(ratesAt({ ...base, launchEndsAt: null }, NOW).hostCommissionPercent).toBe(10);
    expect(ratesAt({ ...base, launchHostCommissionPercent: null }, NOW).hostCommissionPercent).toBe(10);
  });
});

describe('computeAmounts', () => {
  it('30 000 FCFA à 5 % + 3 % : le voyageur paie 30 900, l\'hôte reçoit 28 500, la plateforme garde 2 400', () => {
    expect(computeAmounts(30000, { hostCommissionPercent: 5, travelerFeePercent: 3 })).toEqual({
      amountHeld: 30900, platformFee: 2400, hostPayout: 28500, hostCommission: 1500, travelerFee: 900,
    });
  });
  it('sans frais voyageur, retrouve l\'ancien calcul (10 %)', () => {
    expect(computeAmounts(20000, { hostCommissionPercent: 10, travelerFeePercent: 0 })).toMatchObject({ amountHeld: 20000, platformFee: 2000, hostPayout: 18000, travelerFee: 0 });
  });
  it.each([12345, 9999, 15750, 1])('aucun franc ne se perd : payé = reçu par l\'hôte + gardé par la plateforme (%i)', (price) => {
    const a = computeAmounts(price, { hostCommissionPercent: 7.5, travelerFeePercent: 2.5 });
    expect(a.amountHeld).toBe(a.hostPayout + a.platformFee);
  });
});

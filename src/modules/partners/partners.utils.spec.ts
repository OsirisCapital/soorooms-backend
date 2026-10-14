import { describe, expect, it } from 'vitest';
import { addMonths, computeCommission, generateCode, namesMatch, normalizeCode, splitWithholding } from './partners.utils.js';

describe('partners.utils', () => {
  it('génère des codes lisibles de 6 caractères', () => {
    for (let i = 0; i < 200; i++) expect(generateCode()).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
  });

  it('normalise un code saisi à la main', () => {
    expect(normalizeCode(' abc-123 ')).toBe('ABC123');
  });

  it('ajoute des mois sans déborder sur le mois suivant', () => {
    expect(addMonths(new Date('2026-08-31T10:00:00Z'), 6).toISOString()).toBe('2027-02-28T10:00:00.000Z');
    expect(addMonths(new Date('2026-10-15T00:00:00Z'), 18).toISOString()).toBe('2028-04-15T00:00:00.000Z');
    expect(addMonths(new Date('2026-12-15T00:00:00Z'), 1).toISOString()).toBe('2027-01-15T00:00:00.000Z');
  });

  it('compare les noms sans accent, sans casse, dans n\'importe quel ordre', () => {
    expect(namesMatch('Awa Ngono', 'NGONO awa')).toBe(true);
    expect(namesMatch('Stanislas Féucom', 'feucom stanislas')).toBe(true);
    expect(namesMatch('Awa Ngono', 'Awa Marie Ngono')).toBe(true);
    expect(namesMatch('Awa', 'Awa Ngono')).toBe(false);
    expect(namesMatch('Awa Ngono', 'Paul Ngono')).toBe(false);
    expect(namesMatch('', 'Awa Ngono')).toBe(false);
  });

  it('calcule 20 % du revenu, arrondi vers le bas', () => {
    expect(computeCommission({ revenue: 1500, ratePercent: 20, capPercent: 30, alreadyGranted: 0 })).toBe(300);
    expect(computeCommission({ revenue: 1999, ratePercent: 20, capPercent: 30, alreadyGranted: 0 })).toBe(399);
  });

  it('plafonne le cumul des partenaires sur une réservation', () => {
    // hôte 20 % + voyageur 10 % = 30 % : tient exactement dans le plafond
    expect(computeCommission({ revenue: 1000, ratePercent: 10, capPercent: 30, alreadyGranted: 200 })).toBe(100);
    // plafond abaissé à 25 % : le second est rogné
    expect(computeCommission({ revenue: 1000, ratePercent: 10, capPercent: 25, alreadyGranted: 200 })).toBe(50);
    expect(computeCommission({ revenue: 1000, ratePercent: 10, capPercent: 20, alreadyGranted: 200 })).toBe(0);
  });

  it('ne donne rien sur un revenu nul ou un taux nul', () => {
    expect(computeCommission({ revenue: 0, ratePercent: 20, capPercent: 30, alreadyGranted: 0 })).toBe(0);
    expect(computeCommission({ revenue: 1000, ratePercent: 0, capPercent: 30, alreadyGranted: 0 })).toBe(0);
  });

  it('sépare la retenue du net', () => {
    expect(splitWithholding(10000, 0)).toEqual({ withholding: 0, net: 10000 });
    expect(splitWithholding(10000, 5.5)).toEqual({ withholding: 550, net: 9450 });
  });
});

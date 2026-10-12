import { describe, expect, it } from 'vitest';
import { eventDefaultPrice, guestsError } from './event.utils.js';

describe('salle de fêtes', () => {
  it('additionne le tarif et les options', () => {
    expect(eventDefaultPrice('200000.00', [{ price: '50000' }, { price: 30000 }])).toBe(280000);
    expect(eventDefaultPrice(150000, [])).toBe(150000);
  });
  it('contrôle la capacité', () => {
    expect(guestsError(300, 250)).toMatch(/250 personnes/);
    expect(guestsError(250, 250)).toBeNull();
  });
});

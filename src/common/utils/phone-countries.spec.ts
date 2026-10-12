import { describe, expect, it } from 'vitest';
import { countryForPhone } from './phone-countries.js';

describe('countryForPhone', () => {
  it('reconnaît le Cameroun', () => {
    expect(countryForPhone('+237677123456')).toBe('CM');
  });
  it('reconnaît la France et le Portugal (indicatifs de longueurs différentes)', () => {
    expect(countryForPhone('+33612345678')).toBe('FR');
    expect(countryForPhone('+351912345678')).toBe('PT');
  });
  it("retient US pour l'indicatif partagé +1", () => {
    expect(countryForPhone('+14155550100')).toBe('US');
  });
  it('renvoie null si inconnu ou mal formé', () => {
    expect(countryForPhone('+999123456')).toBeNull();
    expect(countryForPhone('677123456')).toBeNull();
    expect(countryForPhone(null)).toBeNull();
  });
});

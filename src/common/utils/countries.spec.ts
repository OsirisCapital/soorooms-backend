import { describe, expect, it } from 'vitest';
import { DEFAULT_COUNTRY, SUPPORTED_COUNTRIES, findCountry } from './countries.js';

describe('pays pris en charge', () => {
  it('reconnaît un nom (accents, casse) ou un code ISO', () => {
    expect(findCountry('cameroun')?.code).toBe('CM');
    expect(findCountry('  GUINEE EQUATORIALE ')?.name).toBe('Guinée équatoriale');
    expect(findCountry('ga')?.name).toBe('Gabon');
  });

  it('refuse un pays inconnu ou vide', () => {
    expect(findCountry('Sénégal')).toBeNull();
    expect(findCountry('')).toBeNull();
    expect(findCountry(null)).toBeNull();
  });

  it('le pays par défaut est pris en charge, tous en FCFA central', () => {
    expect(findCountry(DEFAULT_COUNTRY)).not.toBeNull();
    expect(SUPPORTED_COUNTRIES.every((c) => c.currency === 'XAF')).toBe(true);
  });
});

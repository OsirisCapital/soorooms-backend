import { describe, expect, it } from 'vitest';
import { termEndDate, termPrice } from './stay-term.utils.js';

const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe('forfaits résidence étudiante', () => {
  it('semestre = 6 mois, année = 12 mois', () => {
    expect(termEndDate(d('2026-10-01'), 'SEMESTER')).toEqual(d('2027-04-01'));
    expect(termEndDate(d('2026-10-01'), 'YEAR')).toEqual(d('2027-10-01'));
  });
  it('fin de mois : on ne déborde pas sur le mois suivant', () => {
    expect(termEndDate(d('2026-08-31'), 'SEMESTER')).toEqual(d('2027-02-28'));
    expect(termEndDate(d('2027-01-31'), 'SEMESTER')).toEqual(d('2027-07-31'));
  });
  it('prix du forfait, ou null s’il n’est pas proposé', () => {
    expect(termPrice({ semesterPrice: '150000', yearPrice: null }, 'SEMESTER')).toBe(150000);
    expect(termPrice({ semesterPrice: '150000', yearPrice: null }, 'YEAR')).toBeNull();
  });
});

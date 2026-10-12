import { describe, expect, it } from 'vitest';
import { CHECKLIST_KEYS, checkVerdict, parseChecklist, validVisitPrice, type Checklist } from './visit.utils.js';

const all = (value: boolean) => Object.fromEntries(CHECKLIST_KEYS.map((k) => [k, value])) as Checklist;

describe('parseChecklist', () => {
  it('accepte une grille complète de booléens', () => {
    expect(parseChecklist(all(true))).toEqual(all(true));
  });
  it('refuse une grille incomplète ou mal typée, et ignore les clés inconnues', () => {
    expect(parseChecklist({ ...all(true), utilities: undefined })).toBeNull();
    expect(parseChecklist({ ...all(true), security: 'oui' })).toBeNull();
    expect(parseChecklist(null)).toBeNull();
    expect(parseChecklist({ ...all(true), intrus: true })).toEqual(all(true));
  });
});

describe('validVisitPrice', () => {
  it('arrondit et borne', () => {
    expect(validVisitPrice('10000')).toBe(10000);
    expect(validVisitPrice(15000.4)).toBe(15000);
    expect(validVisitPrice(10)).toBeNull();
    expect(validVisitPrice(9_999_999)).toBeNull();
    expect(validVisitPrice('abc')).toBeNull();
  });
});

describe('checkVerdict', () => {
  const base = { checklist: all(true), photoCount: 3, report: '' };
  it('valide un logement conforme complet', () => {
    expect(checkVerdict({ ...base, conforming: true }).ok).toBe(true);
  });
  it('exige les photos', () => {
    expect(checkVerdict({ ...base, conforming: true, photoCount: 2 }).ok).toBe(false);
  });
  it('refuse « conforme » si un point manque', () => {
    expect(checkVerdict({ ...base, conforming: true, checklist: { ...all(true), utilities: false } }).ok).toBe(false);
  });
  it('exige une explication pour une non-conformité', () => {
    const grid = { ...all(true), utilities: false };
    expect(checkVerdict({ ...base, conforming: false, checklist: grid, report: 'Court' }).ok).toBe(false);
    expect(checkVerdict({ ...base, conforming: false, checklist: grid, report: "Pas d'eau courante dans la salle de bain." }).ok).toBe(true);
  });
});

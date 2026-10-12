import { describe, expect, it } from 'vitest';
import { peakOccupancy, unitsLeft } from './availability.utils.js';

const d = (day: string) => new Date(`${day}T00:00:00.000Z`);
const stay = (a: string, b: string) => ({ checkInDate: d(a), checkOutDate: d(b) });

describe('peakOccupancy', () => {
  it('0 sans réservation', () => {
    expect(peakOccupancy([], d('2027-01-10'), d('2027-01-12'))).toBe(0);
  });
  it("le jour de départ est libre : un séjour qui part le 12 n'occupe pas la nuit du 12", () => {
    expect(peakOccupancy([stay('2027-01-10', '2027-01-12')], d('2027-01-12'), d('2027-01-14'))).toBe(0);
  });
  it('prend la nuit la plus chargée, pas la somme des réservations', () => {
    const stays = [stay('2027-01-10', '2027-01-12'), stay('2027-01-12', '2027-01-14'), stay('2027-01-11', '2027-01-13')];
    expect(peakOccupancy(stays, d('2027-01-10'), d('2027-01-14'))).toBe(2);
  });
});

describe('unitsLeft', () => {
  it('20 unités, 3 réservations qui se chevauchent : 17 libres', () => {
    const stays = [stay('2027-01-10', '2027-01-15'), stay('2027-01-11', '2027-01-14'), stay('2027-01-12', '2027-01-13')];
    expect(unitsLeft(20, stays, d('2027-01-10'), d('2027-01-15'))).toBe(17);
  });
  it("1 unité (cas d'avant) : prise dès qu'une réservation chevauche", () => {
    expect(unitsLeft(1, [stay('2027-01-10', '2027-01-12')], d('2027-01-11'), d('2027-01-13'))).toBe(0);
    expect(unitsLeft(1, [stay('2027-01-10', '2027-01-12')], d('2027-01-12'), d('2027-01-13'))).toBe(1);
  });
  it('ne descend jamais sous 0, même si la base contient plus de réservations que d\'unités', () => {
    expect(unitsLeft(1, [stay('2027-01-10', '2027-01-12'), stay('2027-01-10', '2027-01-12')], d('2027-01-10'), d('2027-01-12'))).toBe(0);
  });
});

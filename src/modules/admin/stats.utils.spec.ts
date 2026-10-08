import { describe, expect, it } from 'vitest';
import { bucketByDay, dayKey, lastDayKeys, windowStart } from './stats.utils.js';

describe('dayKey (jours du Cameroun, UTC+1)', () => {
  it('23 h 30 à Douala compte pour ce jour-là, pas le suivant', () => {
    expect(dayKey(new Date('2026-10-08T22:30:00Z'))).toBe('2026-10-08'); // 23 h 30 locale
    expect(dayKey(new Date('2026-10-08T23:00:00Z'))).toBe('2026-10-09'); // minuit local
  });
});

describe('lastDayKeys', () => {
  it("renvoie les N derniers jours, du plus ancien à aujourd'hui", () => {
    expect(lastDayKeys(3, new Date('2026-10-08T12:00:00Z'))).toEqual(['2026-10-06', '2026-10-07', '2026-10-08']);
  });

  it('traverse correctement un changement de mois', () => {
    expect(lastDayKeys(3, new Date('2026-11-01T09:00:00Z'))).toEqual(['2026-10-30', '2026-10-31', '2026-11-01']);
  });
});

describe('windowStart', () => {
  it('commence à minuit heure du Cameroun, soit 23 h la veille en UTC', () => {
    expect(windowStart('2026-10-06').toISOString()).toBe('2026-10-05T23:00:00.000Z');
  });
});

describe('bucketByDay', () => {
  const keys = ['2026-10-06', '2026-10-07', '2026-10-08'];

  it('compte par jour et met 0 les jours sans donnée', () => {
    const items = [
      { date: new Date('2026-10-06T08:00:00Z') },
      { date: new Date('2026-10-06T20:00:00Z') },
      { date: new Date('2026-10-08T01:00:00Z') },
    ];
    expect(bucketByDay(items, keys)).toEqual([2, 0, 1]);
  });

  it('additionne les valeurs (montants)', () => {
    const items = [
      { date: new Date('2026-10-07T10:00:00Z'), value: 15000 },
      { date: new Date('2026-10-07T11:00:00Z'), value: 22500 },
    ];
    expect(bucketByDay(items, keys)).toEqual([0, 37500, 0]);
  });

  it('ignore ce qui est hors de la fenêtre', () => {
    expect(bucketByDay([{ date: new Date('2026-09-01T10:00:00Z') }, { date: new Date('2026-12-01T10:00:00Z') }], keys)).toEqual([0, 0, 0]);
  });

  it('classe selon le jour du Cameroun : 23 h 30 UTC est déjà le lendemain à Douala', () => {
    expect(bucketByDay([{ date: new Date('2026-10-06T23:30:00Z') }], keys)).toEqual([0, 1, 0]);
  });
});

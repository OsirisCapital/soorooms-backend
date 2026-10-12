import { describe, expect, it } from 'vitest';
import { currentHourWat, napFits, stayFitsHourly, usedAt } from './nap.utils.js';

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const stay = (a: string, b: string, units = 1) => ({ checkInDate: d(a), checkOutDate: d(b), units });
const nap = (day: string, start: number, hours: number) => ({ checkInDate: d(day), checkOutDate: d('2099-12-31'), napStartHour: start, napHours: hours });

describe('siestes — occupation heure par heure', () => {
  it('un séjour occupe la journée du milieu, le soir d’arrivée et le matin du départ', () => {
    const s = [stay('2099-03-05', '2099-03-07')];
    expect(usedAt(s, d('2099-03-06'), 3)).toBe(1);
    expect(usedAt(s, d('2099-03-05'), 10)).toBe(0);
    expect(usedAt(s, d('2099-03-05'), 15)).toBe(1);
    expect(usedAt(s, d('2099-03-07'), 10)).toBe(1);
    expect(usedAt(s, d('2099-03-07'), 13)).toBe(0);
  });

  it('une sieste rentre l’après-midi du jour de départ d’un client, pas pendant son séjour', () => {
    const s = [stay('2099-03-05', '2099-03-07')];
    expect(napFits(1, s, d('2099-03-07'), 13, 3)).toBe(true);
    expect(napFits(1, s, d('2099-03-07'), 10, 3)).toBe(false);
    expect(napFits(1, s, d('2099-03-06'), 14, 3)).toBe(false);
    expect(napFits(1, s, d('2099-03-05'), 10, 3)).toBe(true);
    expect(napFits(1, s, d('2099-03-05'), 12, 3)).toBe(false);
  });

  it('deux siestes ne se chevauchent pas sur une seule unité, mais le peuvent avec plusieurs', () => {
    const n = [nap('2099-03-06', 14, 3)];
    expect(napFits(1, n, d('2099-03-06'), 16, 2)).toBe(false);
    expect(napFits(1, n, d('2099-03-06'), 17, 2)).toBe(true);
    expect(napFits(2, n, d('2099-03-06'), 15, 3)).toBe(true);
  });

  it('un séjour est refusé s’il chevauche une sieste déjà prise sur l’unique chambre', () => {
    const n = [nap('2099-03-06', 15, 3)];
    expect(stayFitsHourly(1, n, d('2099-03-06'), d('2099-03-08'), 1)).toBe(false);
    expect(stayFitsHourly(1, n, d('2099-03-06'), d('2099-03-08'), 1)).toBe(false);
    expect(stayFitsHourly(2, n, d('2099-03-06'), d('2099-03-08'), 1)).toBe(true);
    expect(stayFitsHourly(1, n, d('2099-03-07'), d('2099-03-08'), 1)).toBe(true);
  });

  it('heure courante à Douala (UTC+1)', () => {
    expect(currentHourWat(new Date('2099-03-06T23:30:00Z'))).toEqual({ date: '2099-03-07', hour: 0 });
  });
});

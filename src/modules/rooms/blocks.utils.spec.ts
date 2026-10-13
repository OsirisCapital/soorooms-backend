import { describe, expect, it } from 'vitest';
import { unitsLeft } from './availability.utils.js';
import { blockAsStay, blockedUnitsOn, calendarDays, parseDay } from './blocks.utils.js';

const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe('parseDay', () => {
  it('accepte une vraie date AAAA-MM-JJ, refuse le reste', () => {
    expect(parseDay('2026-10-20')?.toISOString()).toBe('2026-10-20T00:00:00.000Z');
    for (const bad of ['2026-02-30', '20/10/2026', '', '2026-13-01']) expect(parseDay(bad)).toBeNull();
  });
});

describe('blockAsStay', () => {
  it('ferme tout le type par défaut, ou le nombre d’unités demandé', () => {
    const b = { startDate: d('2026-10-20'), endDate: d('2026-10-23'), units: null };
    expect(blockAsStay(b, 5).units).toBe(5);
    expect(blockAsStay({ ...b, units: 2 }, 5).units).toBe(2);
    expect(blockAsStay({ ...b, units: 9 }, 5).units).toBe(5);
  });
  it('retire des unités libres sur les nuits fermées seulement', () => {
    const b = { startDate: d('2026-10-20'), endDate: d('2026-10-23'), units: 2 };
    expect(unitsLeft(3, [blockAsStay(b, 3)], d('2026-10-21'), d('2026-10-22'))).toBe(1);
    expect(unitsLeft(3, [blockAsStay(b, 3)], d('2026-10-23'), d('2026-10-24'))).toBe(3);
  });
});

describe('blockedUnitsOn', () => {
  it('compte les fermetures qui couvrent la date, jamais plus que le type', () => {
    const blocks = [
      { startDate: d('2026-10-20'), endDate: d('2026-10-22'), units: 2 },
      { startDate: d('2026-10-21'), endDate: d('2026-10-24'), units: 2 },
    ];
    expect(blockedUnitsOn(blocks, d('2026-10-20'), 3)).toBe(2);
    expect(blockedUnitsOn(blocks, d('2026-10-21'), 3)).toBe(3);
    expect(blockedUnitsOn(blocks, d('2026-10-24'), 3)).toBe(0);
  });
});

describe('calendarDays', () => {
  it('donne par jour les unités réservées, fermées et libres', () => {
    const stays = [{ checkInDate: d('2026-10-20'), checkOutDate: d('2026-10-22') }];
    const blocks = [{ startDate: d('2026-10-21'), endDate: d('2026-10-23'), units: null }];
    const days = calendarDays(2, stays, blocks, d('2026-10-20'), 4);
    expect(days.map((x) => [x.date, x.booked, x.blocked, x.free])).toEqual([
      ['2026-10-20', 1, 0, 1],
      ['2026-10-21', 1, 2, 0],
      ['2026-10-22', 0, 2, 0],
      ['2026-10-23', 0, 0, 2],
    ]);
  });
});

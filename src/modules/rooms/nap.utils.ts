/**
 * Siestes : séjours de quelques heures. Une sieste occupe une unité de chambre pendant une plage d'heures
 * d'UNE date ; elle n'occupe jamais « la nuit » (elle est exclue du calcul de disponibilité par nuits).
 * En contrepartie, siestes et séjours se vérifient entre eux heure par heure, ici. Fonctions pures.
 *
 * Un séjour occupe la chambre : toute la journée entre l'arrivée et le départ, à partir de CHECKIN_HOUR le
 * jour de l'arrivée, jusqu'à CHECKOUT_HOUR le jour du départ.
 */
export const CHECKIN_HOUR = 14;
export const CHECKOUT_HOUR = 12;
export const NAP_MAX_HOURS = 12;

export type HourBlocker = {
  checkInDate: Date;
  checkOutDate: Date;
  units?: number;
  napStartHour?: number | null;
  napHours?: number | null;
};

const DAY_MS = 24 * 3_600_000;
const dayOf = (d: Date) => Math.floor(d.getTime() / DAY_MS);

function blocksHour(b: HourBlocker, day: number, hour: number): boolean {
  const inDay = dayOf(b.checkInDate);
  if (b.napStartHour != null) {
    return day === inDay && hour >= b.napStartHour && hour < b.napStartHour + (b.napHours ?? 1);
  }
  const outDay = dayOf(b.checkOutDate);
  if (day > inDay && day < outDay) return true;
  if (day === inDay) return hour >= CHECKIN_HOUR;
  if (day === outDay) return hour < CHECKOUT_HOUR;
  return false;
}

/** Unités occupées à une heure donnée d'une date. */
export function usedAt(blockers: readonly HourBlocker[], date: Date, hour: number): number {
  const day = dayOf(date);
  let used = 0;
  for (const b of blockers) if (blocksHour(b, day, hour)) used += b.units ?? 1;
  return used;
}

/** Une sieste de `hours` heures à partir de `startHour` rentre-t-elle (au moins une unité libre à chaque heure) ? */
export function napFits(unitCount: number, blockers: readonly HourBlocker[], date: Date, startHour: number, hours: number): boolean {
  for (let h = startHour; h < startHour + hours; h += 1) {
    if (usedAt(blockers, date, h) + 1 > unitCount) return false;
  }
  return true;
}

/**
 * Un séjour de `units` chambres du `checkIn` au `checkOut` rentre-t-il malgré les siestes (et autres
 * occupations) déjà prises ? Contrôle heure par heure sur chaque jour touché par le séjour.
 */
export function stayFitsHourly(unitCount: number, blockers: readonly HourBlocker[], checkIn: Date, checkOut: Date, units: number): boolean {
  const first = dayOf(checkIn);
  const last = dayOf(checkOut);
  const candidate: HourBlocker = { checkInDate: checkIn, checkOutDate: checkOut };
  for (let day = first; day <= last && day - first <= 800; day += 1) {
    const date = new Date(day * DAY_MS);
    for (let h = 0; h < 24; h += 1) {
      if (!blocksHour(candidate, day, h)) continue;
      if (usedAt(blockers, date, h) + units > unitCount) return false;
    }
  }
  return true;
}

/** Heure actuelle (0-23) à Douala/Libreville (UTC+1), pour refuser une sieste dans le passé. */
export function currentHourWat(now = new Date()): { date: string; hour: number } {
  const wat = new Date(now.getTime() + 3_600_000);
  return { date: wat.toISOString().slice(0, 10), hour: wat.getUTCHours() };
}

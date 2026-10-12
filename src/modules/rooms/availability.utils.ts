/**
 * Disponibilité d'un type de chambre à plusieurs unités. Fonctions pures.
 *
 * Un type a `unitCount` unités identiques. Chaque réservation qui bloque le calendrier en occupe une
 * sur ses nuits (arrivée incluse, départ exclu). Pour un séjour donné, il reste de la place si, sur
 * CHAQUE nuit du séjour, au moins une unité est libre : on prend donc la nuit la plus chargée.
 */
export const BLOCKING_STATUSES = ['PENDING_PAYMENT', 'DEPOSIT_PAID', 'CONFIRMED_ESCROW', 'COMPLETED'] as const;

export type Stay = { checkInDate: Date; checkOutDate: Date };

const DAY_MS = 24 * 3_600_000;
/** Garde-fou : on ne parcourt jamais plus de deux ans de nuits d'un coup. */
const MAX_NIGHTS = 800;

/** Nombre maximal d'unités occupées en même temps sur les nuits [from, to). */
export function peakOccupancy(stays: readonly Stay[], from: Date, to: Date): number {
  let peak = 0;
  const end = Math.min(to.getTime(), from.getTime() + MAX_NIGHTS * DAY_MS);
  for (let t = from.getTime(); t < end; t += DAY_MS) {
    let used = 0;
    for (const stay of stays) {
      if (stay.checkInDate.getTime() <= t && t < stay.checkOutDate.getTime()) used += 1;
    }
    if (used > peak) peak = used;
  }
  return peak;
}

/** Unités encore libres sur toutes les nuits du séjour demandé (0 si complet). */
export function unitsLeft(unitCount: number, stays: readonly Stay[], from: Date, to: Date): number {
  return Math.max(0, unitCount - peakOccupancy(stays, from, to));
}

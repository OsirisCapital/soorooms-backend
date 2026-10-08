/**
 * Découpage par jour pour les courbes du tableau de bord. Les jours sont ceux du Cameroun (UTC+1,
 * sans changement d'heure) : une inscription à 23 h 30 à Douala compte pour ce jour-là, pas le suivant.
 */
export const CAMEROON_UTC_OFFSET_HOURS = 1;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Jour calendaire « AAAA-MM-JJ » d'un instant, à l'heure du Cameroun. */
export function dayKey(date: Date, offsetHours = CAMEROON_UTC_OFFSET_HOURS): string {
  return new Date(date.getTime() + offsetHours * HOUR_MS).toISOString().slice(0, 10);
}

/** Les `days` derniers jours, du plus ancien à aujourd'hui compris. */
export function lastDayKeys(days: number, now: Date, offsetHours = CAMEROON_UTC_OFFSET_HOURS): string[] {
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) keys.push(dayKey(new Date(now.getTime() - i * DAY_MS), offsetHours));
  return keys;
}

/** Instant (UTC) où commence le premier jour de la fenêtre : minuit à l'heure du Cameroun. */
export function windowStart(firstKey: string, offsetHours = CAMEROON_UTC_OFFSET_HOURS): Date {
  return new Date(new Date(`${firstKey}T00:00:00.000Z`).getTime() - offsetHours * HOUR_MS);
}

/** Additionne `value` (1 par défaut) par jour ; un jour sans donnée vaut 0. Hors fenêtre : ignoré. */
export function bucketByDay(
  items: ReadonlyArray<{ date: Date; value?: number }>,
  keys: readonly string[],
  offsetHours = CAMEROON_UTC_OFFSET_HOURS,
): number[] {
  const totals = new Map(keys.map((key) => [key, 0]));
  for (const item of items) {
    const key = dayKey(item.date, offsetHours);
    if (totals.has(key)) totals.set(key, (totals.get(key) ?? 0) + (item.value ?? 1));
  }
  return keys.map((key) => totals.get(key) ?? 0);
}

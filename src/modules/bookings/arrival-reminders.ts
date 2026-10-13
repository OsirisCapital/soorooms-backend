/**
 * Rappel d'arrivée : quand l'envoyer et comment le dire. Fonctions pures (testées) ; le service qui
 * interroge la base est dans arrival-reminders.service.ts.
 */
import { arrivalInstant, type RefundKind } from './refund-policy.js';

const HOUR_MS = 3_600_000;
const WAT_OFFSET_HOURS = 1;
/** Séjour : rappel dans les 24 h qui précèdent l'arrivée. Sieste : 3 h avant le début. */
const STAY_LEAD_HOURS = 24;
const NAP_LEAD_HOURS = 3;

export function reminderLeadHours(kind: RefundKind): number {
  return kind === 'NAP' ? NAP_LEAD_HOURS : STAY_LEAD_HOURS;
}

/** Vrai si l'arrivée est à venir et assez proche pour qu'on la rappelle maintenant. */
export function isReminderDue(kind: RefundKind, checkInDate: Date, napStartHour: number | null | undefined, now: Date): boolean {
  const ms = arrivalInstant(kind, checkInDate, napStartHour).getTime() - now.getTime();
  return ms > 0 && ms <= reminderLeadHours(kind) * HOUR_MS;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** « aujourd'hui à 14 h », « demain à 14 h » ou « le 18/10/2026 à 14 h » (heure du Cameroun). Salle : sans heure. */
export function arrivalLabel(kind: RefundKind, checkInDate: Date, napStartHour: number | null | undefined, now: Date): string {
  const arrival = new Date(arrivalInstant(kind, checkInDate, napStartHour).getTime() + WAT_OFFSET_HOURS * HOUR_MS);
  const nowWat = new Date(now.getTime() + WAT_OFFSET_HOURS * HOUR_MS);
  const dayKey = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const diffDays = Math.round((dayKey(arrival) - dayKey(nowWat)) / (24 * HOUR_MS));
  const day = diffDays === 0 ? "aujourd'hui" : diffDays === 1 ? 'demain' : `le ${pad(arrival.getUTCDate())}/${pad(arrival.getUTCMonth() + 1)}/${arrival.getUTCFullYear()}`;
  if (kind === 'HALL') return day;
  return `${day} à ${arrival.getUTCHours()} h`;
}

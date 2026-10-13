/** Regroupement des erreurs serveur : une même cause = une même empreinte. Fonctions pures (testées). */
import { createHash } from 'node:crypto';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** « /bookings/3f2a…/cancel?x=1 » → « /bookings/:id/cancel » : l'identifiant ne doit pas créer une erreur par réservation. */
export function normalizePath(path: string): string {
  return path
    .split('?')[0]
    .replace(UUID, ':id')
    .replace(/\/\d+(?=\/|$)/g, '/:n')
    .slice(0, 200);
}

/** Message sans valeurs variables (identifiants, nombres longs) et borné : il sert à regrouper et s'affiche à l'équipe. */
export function normalizeMessage(message: string): string {
  return message.replace(UUID, ':id').replace(/\s+/g, ' ').trim().slice(0, 300);
}

export function fingerprint(method: string, path: string, message: string): string {
  return createHash('sha1').update(`${method.toUpperCase()} ${normalizePath(path)} ${normalizeMessage(message)}`).digest('hex').slice(0, 16);
}

/** Seuils de répétition qui déclenchent une nouvelle alerte (la première occurrence en déclenche toujours une). */
const ALERT_COUNTS = new Set([10, 100, 1000, 10000]);

export function shouldAlert(input: { isNew: boolean; reopened: boolean; count: number }): boolean {
  return input.isNew || input.reopened || ALERT_COUNTS.has(input.count);
}

/** Erreur quelconque → message lisible (jamais d'objet inattendu). */
export function describeError(error: unknown): { message: string; stack: string | null } {
  if (error instanceof Error) return { message: error.message || error.name, stack: error.stack ? error.stack.slice(0, 4000) : null };
  if (typeof error === 'string') return { message: error, stack: null };
  try {
    return { message: JSON.stringify(error).slice(0, 300), stack: null };
  } catch {
    return { message: 'Erreur inconnue', stack: null };
  }
}

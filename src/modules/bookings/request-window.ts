/**
 * Délai de réponse d'une demande de réservation : chaque offre en attente doit recevoir une réponse
 * dans les 2 heures, sinon la demande expire (le voyageur peut alors chercher ailleurs).
 * Aucun champ en base : l'échéance se déduit de la date de l'offre en cours.
 */
export const RESPONSE_WINDOW_MS = 2 * 3_600_000;

/** Nombre maximal de demandes ouvertes (en attente de réponse) pour un même voyageur. */
export const MAX_OPEN_REQUESTS = 3;

export function responseDeadline(offerCreatedAt: Date): Date {
  return new Date(offerCreatedAt.getTime() + RESPONSE_WINDOW_MS);
}

export function isExpired(offerCreatedAt: Date, now: Date = new Date()): boolean {
  return now.getTime() >= responseDeadline(offerCreatedAt).getTime();
}

/**
 * Règles d'acquisition des points de fidélité. Fonctions pures : c'est le SEUL endroit à modifier pour
 * changer les barèmes.
 *
 * Les points se gagnent à la fin d'un séjour (ou événement) — c'est-à-dire quand le voyageur et l'hôte ont
 * tous deux confirmé et que la réservation passe à « Terminée » — jamais à la réservation ni au paiement.
 */

/** 1 point par tranche de 1 000 FCFA du prix convenu (hors frais de service). */
export const XAF_PER_POINT = 1000;
/** Bonus unique, au premier séjour terminé du voyageur. */
export const FIRST_STAY_BONUS = 100;

export const REASONS = ['STAY_COMPLETED', 'FIRST_STAY_BONUS'] as const;
export type LoyaltyReason = (typeof REASONS)[number];

export function stayPoints(agreedPrice: number): number {
  if (!Number.isFinite(agreedPrice) || agreedPrice <= 0) return 0;
  return Math.floor(agreedPrice / XAF_PER_POINT);
}

/** Lignes à créer pour un séjour terminé. `isFirstStay` : le voyageur n'a encore aucun séjour terminé. */
export function pointsToAward(agreedPrice: number, isFirstStay: boolean): { reason: LoyaltyReason; points: number }[] {
  const lines: { reason: LoyaltyReason; points: number }[] = [];
  const base = stayPoints(agreedPrice);
  if (base > 0) lines.push({ reason: 'STAY_COMPLETED', points: base });
  if (isFirstStay) lines.push({ reason: 'FIRST_STAY_BONUS', points: FIRST_STAY_BONUS });
  return lines;
}

/** Règles affichées aux utilisateurs (la page de points lit cette liste : une seule source de vérité). */
export const EARNING_RULES = [
  { reason: 'STAY_COMPLETED', title: 'Séjour ou événement terminé', detail: `1 point par tranche de ${XAF_PER_POINT.toLocaleString('fr-FR')} FCFA du prix convenu` },
  { reason: 'FIRST_STAY_BONUS', title: 'Premier séjour terminé', detail: `+${FIRST_STAY_BONUS} points, une seule fois` },
] as const;

/** À quoi serviront les points — annoncé sans détail, le programme complet viendra plus tard. */
export const UPCOMING_USES = [
  'Réductions sur vos prochaines réservations',
  'Nuits offertes',
  'Services partenaires (navette, petit-déjeuner…)',
  'Surclassements de chambre',
  'Offres et accès prioritaires',
] as const;

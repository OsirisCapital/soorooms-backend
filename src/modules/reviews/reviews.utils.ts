/** Calculs et affichage des avis. Fonctions pures (testées). */

/** « Marie Kouam Ngono » → « Marie K. » : un avis public ne donne jamais le nom complet. */
export function publicAuthorName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Voyageur';
  const first = parts[0];
  const initial = parts[1]?.[0];
  return initial ? `${first} ${initial.toUpperCase()}.` : first;
}

/** Moyenne sur 5, arrondie au dixième ; null sans aucun avis. */
export function averageRating(ratings: readonly number[]): number | null {
  if (ratings.length === 0) return null;
  const sum = ratings.reduce((a, b) => a + b, 0);
  return Math.round((sum / ratings.length) * 10) / 10;
}

/** Nombre d'avis par note, de 5 à 1. */
export function ratingDistribution(ratings: readonly number[]): Record<1 | 2 | 3 | 4 | 5, number> {
  const out = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of ratings) if (r >= 1 && r <= 5) out[r as 1 | 2 | 3 | 4 | 5] += 1;
  return out;
}

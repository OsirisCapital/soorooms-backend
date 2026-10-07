/** Forme canonique d'une adresse e-mail : sans espaces autour, en minuscules. Appliquée avant validation. */
export function normalizeEmail(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

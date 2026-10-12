/**
 * Règles pures de la visite de vérification : grille de contrôle, verdict, prix par défaut.
 * Aucune lecture en base : tout est testé dans visit.utils.spec.ts.
 */

/** Tarif appliqué tant que le super administrateur n'en a pas fixé un (FCFA). */
export const DEFAULT_VISIT_PRICE = 10_000;
export const MIN_VISIT_PRICE = 1_000;
export const MAX_VISIT_PRICE = 200_000;

/** Photos minimales que l'agent doit prendre sur place. */
export const MIN_VISIT_PHOTOS = 3;
export const MAX_VISIT_PHOTOS = 20;

export const CHECKLIST_ITEMS = [
  { key: 'locationMatches', label: "L'adresse et la localisation correspondent à l'annonce" },
  { key: 'photosMatch', label: 'Les photos de l’annonce correspondent à la réalité' },
  { key: 'hostOnSite', label: 'Le gérant est présent et identifié sur place' },
  { key: 'cleanliness', label: 'Le logement est propre et en bon état' },
  { key: 'utilities', label: 'Eau et électricité fonctionnent' },
  { key: 'security', label: 'Les accès sont sécurisés (porte, serrure)' },
  { key: 'amenitiesMatch', label: 'Les équipements annoncés sont présents' },
] as const;

export type ChecklistKey = (typeof CHECKLIST_ITEMS)[number]['key'];
export const CHECKLIST_KEYS = CHECKLIST_ITEMS.map((i) => i.key) as ChecklistKey[];
export type Checklist = Record<ChecklistKey, boolean>;

/** Statuts d'une visite encore en cours : une seule à la fois par logement. */
export const OPEN_VISIT_STATUSES = ['AWAITING_PAYMENT', 'PENDING_ASSIGNMENT', 'ASSIGNED'] as const;

/** Garde uniquement les clés connues, en booléens stricts ; null si la grille est incomplète. */
export function parseChecklist(input: unknown): Checklist | null {
  if (!input || typeof input !== 'object') return null;
  const source = input as Record<string, unknown>;
  const result = {} as Checklist;
  for (const key of CHECKLIST_KEYS) {
    if (typeof source[key] !== 'boolean') return null;
    result[key] = source[key] as boolean;
  }
  return result;
}

export const allChecked = (checklist: Checklist) => CHECKLIST_KEYS.every((k) => checklist[k]);

/** Prix saisi → entier de FCFA dans les bornes, sinon null. */
export function validVisitPrice(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  return rounded >= MIN_VISIT_PRICE && rounded <= MAX_VISIT_PRICE ? rounded : null;
}

export type VerdictCheck = { ok: true } | { ok: false; message: string };

/**
 * Un logement ne peut être déclaré conforme que si TOUTE la grille est cochée et que les photos sont
 * là ; une non-conformité doit être expliquée à l'hôte.
 */
export function checkVerdict(params: { conforming: boolean; checklist: Checklist; photoCount: number; report: string }): VerdictCheck {
  if (params.photoCount < MIN_VISIT_PHOTOS) {
    return { ok: false, message: `Ajoutez au moins ${MIN_VISIT_PHOTOS} photos prises sur place.` };
  }
  if (params.conforming && !allChecked(params.checklist)) {
    return { ok: false, message: 'Un logement ne peut être conforme que si tous les points de la grille sont validés.' };
  }
  if (!params.conforming && params.report.trim().length < 10) {
    return { ok: false, message: 'Expliquez à l’hôte ce qui n’est pas conforme (au moins une phrase).' };
  }
  return { ok: true };
}

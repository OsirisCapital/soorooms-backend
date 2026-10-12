/**
 * Pays où SòôRooms accepte des logements. Pour l'instant : la zone du franc CFA d'Afrique centrale, où le
 * paiement en FCFA (XAF) fonctionne tel quel. Les autres zones (XOF, devises locales) demanderont une
 * gestion des devises dans le paiement : on les ajoutera ici le moment venu, une ligne par pays.
 */
export type SupportedCountry = { code: string; name: string; currency: 'XAF' };

export const SUPPORTED_COUNTRIES: readonly SupportedCountry[] = [
  { code: 'CM', name: 'Cameroun', currency: 'XAF' },
  { code: 'GA', name: 'Gabon', currency: 'XAF' },
  { code: 'CG', name: 'Congo', currency: 'XAF' },
  { code: 'TD', name: 'Tchad', currency: 'XAF' },
  { code: 'CF', name: 'Centrafrique', currency: 'XAF' },
  { code: 'GQ', name: 'Guinée équatoriale', currency: 'XAF' },
];

export const DEFAULT_COUNTRY = 'Cameroun';

const fold = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();

/** Pays reconnu à partir de son nom (accents et casse ignorés) ou de son code ISO ; null si non pris en charge. */
export function findCountry(input: string | null | undefined): SupportedCountry | null {
  if (!input) return null;
  const key = fold(input);
  return SUPPORTED_COUNTRIES.find((c) => fold(c.name) === key || c.code.toLowerCase() === key) ?? null;
}

/**
 * Forme canonique des numéros camerounais : « +237XXXXXXXXX ».
 *
 * Sans normalisation, « 677123456 », « 677 12 34 56 » et « +237677123456 »
 * passaient tous la validation IsPhoneNumber('CM') mais étaient enregistrés
 * tels quels : le même numéro pouvait créer plusieurs comptes, et un
 * utilisateur ne pouvait plus se connecter s'il changeait de format de saisie.
 * Appliquée via @Transform sur les DTO, avant la validation.
 */
export function normalizePhone(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  let v = value.replace(/[\s.\-()]/g, '');
  if (v.startsWith('00')) v = `+${v.slice(2)}`;
  if (/^237\d{9}$/.test(v)) v = `+${v}`;
  if (/^[26]\d{8}$/.test(v)) v = `+237${v}`;
  return v;
}

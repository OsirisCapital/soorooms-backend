/**
 * Numéro WhatsApp du support : on le range au format international « +237… » (celui de wa.me).
 * Un mobile camerounais saisi en local (9 chiffres commençant par 6) reçoit +237 ; tout autre numéro doit
 * déjà porter son indicatif. Renvoie null si ce n'est pas un numéro plausible.
 */
export function normalizeSupportPhone(input: string): string | null {
  const cleaned = input.replace(/[\s().-]/g, '');
  if (!/^(\+|00)?\d+$/.test(cleaned)) return null;
  const digits = cleaned.replace(/^\+/, '').replace(/^00/, '');
  if (!cleaned.startsWith('+') && !cleaned.startsWith('00') && /^6\d{8}$/.test(digits)) return `+237${digits}`;
  return /^\d{8,15}$/.test(digits) && (cleaned.startsWith('+') || cleaned.startsWith('00') || digits.length > 9) ? `+${digits}` : null;
}

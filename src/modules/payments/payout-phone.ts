/**
 * Numéro Mobile Money camerounais : on accepte « 6 70 00 00 00 », « 670000000 », « +237 670000000 »,
 * « 237670000000 » et on range tout sous la forme « +237670000000 » attendue par Notch Pay.
 * Renvoie `null` si le numéro n'est pas un mobile camerounais (9 chiffres commençant par 6).
 */
export function normalizeCameroonMobile(input: string): string | null {
  const digits = input.replace(/[\s().-]/g, '').replace(/^\+/, '').replace(/^00/, '');
  if (!/^\d+$/.test(digits)) return null;
  const national = digits.startsWith('237') ? digits.slice(3) : digits;
  return /^6\d{8}$/.test(national) ? `+237${national}` : null;
}

export const PAYOUT_CHANNELS = ['cm.mtn', 'cm.orange'] as const;
export const PAYOUT_CHANNEL_LABEL: Record<(typeof PAYOUT_CHANNELS)[number], string> = {
  'cm.mtn': 'MTN Mobile Money',
  'cm.orange': 'Orange Money',
};

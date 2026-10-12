/**
 * Indicatifs téléphoniques → pays (ISO 3166-1 alpha-2).
 * Sert à déduire le pays d'un compte à partir de son numéro (+237… → CM).
 * L'indicatif « 1 » est partagé (États-Unis, Canada…) : on retient US par défaut.
 */
const DIAL_CODES: Record<string, string> = {
  '237': 'CM',
  '229': 'BJ', '226': 'BF', '257': 'BI', '238': 'CV', '236': 'CF', '235': 'TD',
  '269': 'KM', '242': 'CG', '243': 'CD', '225': 'CI', '253': 'DJ', '20': 'EG',
  '240': 'GQ', '241': 'GA', '220': 'GM', '233': 'GH', '224': 'GN', '254': 'KE',
  '212': 'MA', '223': 'ML', '222': 'MR', '230': 'MU', '227': 'NE', '234': 'NG',
  '250': 'RW', '221': 'SN', '232': 'SL', '27': 'ZA', '228': 'TG', '216': 'TN',
  '213': 'DZ', '256': 'UG', '255': 'TZ', '251': 'ET', '244': 'AO', '261': 'MG',
  '33': 'FR', '32': 'BE', '41': 'CH', '49': 'DE', '39': 'IT', '34': 'ES',
  '351': 'PT', '44': 'GB', '31': 'NL', '1': 'US', '86': 'CN', '971': 'AE',
  '90': 'TR', '91': 'IN', '55': 'BR', '961': 'LB', '966': 'SA',
};

/** Pays déduit d'un numéro « +XXXXXXXX » (indicatif le plus long d'abord), ou null. */
export function countryForPhone(phone: string | null | undefined): string | null {
  if (!phone || !phone.startsWith('+')) return null;
  const digits = phone.slice(1);
  for (const len of [3, 2, 1]) {
    const code = DIAL_CODES[digits.slice(0, len)];
    if (code) return code;
  }
  return null;
}

/** Résidence étudiante : forfaits au semestre (6 mois) et à l'année (12 mois), à partir d'une date d'entrée. */
export const STAY_TERMS = ['SEMESTER', 'YEAR'] as const;
export type StayTerm = (typeof STAY_TERMS)[number];

export const STAY_TERM_MONTHS: Record<StayTerm, number> = { SEMESTER: 6, YEAR: 12 };
export const STAY_TERM_LABEL: Record<StayTerm, string> = { SEMESTER: 'Semestre (6 mois)', YEAR: 'Année (12 mois)' };

/** Date de sortie : l'entrée + 6 ou 12 mois (le 31 janvier + 6 mois donne le 31 juillet ; le 31 août + 6 mois, le 28 ou 29 février). */
export function termEndDate(entry: Date, term: StayTerm): Date {
  const end = new Date(entry.getTime());
  const day = end.getUTCDate();
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() + STAY_TERM_MONTHS[term]);
  const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  end.setUTCDate(Math.min(day, lastDay));
  return end;
}

/** Prix du forfait demandé, ou null si la résidence ne le propose pas. */
export function termPrice(room: { semesterPrice?: unknown; yearPrice?: unknown }, term: StayTerm): number | null {
  const raw = term === 'SEMESTER' ? room.semesterPrice : room.yearPrice;
  return raw == null ? null : Number(raw);
}

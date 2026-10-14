/** Fonctions pures du programme partenaire (testées dans partners.utils.spec.ts). */
import { randomInt } from 'node:crypto';

// Sans 0/O/1/I/L : un code se lit à voix haute et se recopie sur WhatsApp.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateCode(): string {
  let out = '';
  for (let i = 0; i < 6; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

export function normalizeCode(input: string): string {
  return input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Ajoute des mois calendaires (le 31 + 1 mois = dernier jour du mois suivant, jamais un débordement). */
export function addMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

function tokens(name: string): string[] {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, ' ')
    .split(/[\s'-]+/)
    .filter((t) => t.length > 0);
}

/**
 * Le nom du compte de paiement doit être celui de la personne : mêmes mots, dans n'importe quel ordre,
 * sans tenir compte des accents ni de la casse. Un nom plus court est accepté s'il est contenu dans l'autre
 * et compte au moins deux mots (« Awa Ngono » pour « Awa Marie Ngono »).
 */
export function namesMatch(a: string, b: string): boolean {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 || tb.size === 0) return false;
  const [short, long] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  if (short.size === 1 && long.size > 1) return false;
  return [...short].every((t) => long.has(t));
}

export type CommissionInput = {
  revenue: number;
  ratePercent: number;
  capPercent: number;
  /** Commissions déjà accordées à d'autres partenaires sur la même réservation. */
  alreadyGranted: number;
};

/** Commission en FCFA entiers (arrondie vers le bas), sans jamais dépasser le plafond cumulé de la réservation. */
export function computeCommission({ revenue, ratePercent, capPercent, alreadyGranted }: CommissionInput): number {
  if (!(revenue > 0) || !(ratePercent > 0)) return 0;
  const wanted = Math.floor((revenue * ratePercent) / 100);
  const room = Math.floor((revenue * capPercent) / 100) - alreadyGranted;
  return Math.max(0, Math.min(wanted, room));
}

/** Montant retenu à la source (FCFA entiers) et net versé. */
export function splitWithholding(gross: number, withholdingPercent: number): { withholding: number; net: number } {
  const withholding = withholdingPercent > 0 ? Math.floor((gross * withholdingPercent) / 100) : 0;
  return { withholding, net: gross - withholding };
}

export const PARTNER_TERMS = [
  "Vous recevez une commission sur le revenu que SòôRooms conserve réellement sur les réservations des hôtes et voyageurs que vous avez parrainés, aux taux et pour les durées affichés dans votre espace.",
  "En cas d'annulation ou de remboursement, la commission porte sur le revenu que SòôRooms a effectivement conservé : aucune commission n'est reprise sur ce qui a déjà été gagné, et rien n'est dû sur ce qui a été remboursé.",
  "Le programme est ouvert à toute personne majeure titulaire d'un compte SòôRooms, hors membres de l'équipe SòôRooms : un membre de l'équipe ne peut pas devenir partenaire, et un partenaire qui rejoint l'équipe ne perçoit plus de commission tant qu'il en fait partie (ses gains déjà acquis restent retirables).",
  "Vous ne gagnez rien sur vos propres logements ni sur vos propres réservations, ni sur un compte de votre entourage créé pour contourner cette règle.",
  "Le retrait se fait sur un compte Mobile Money à votre nom, après vérification de votre identité. Des retenues fiscales peuvent s'appliquer selon la loi en vigueur.",
  "Le règlement complet du programme est consultable à tout moment sur la page « Règlement du programme partenaire ».",
  "SòôRooms peut modifier ou suspendre le programme ; les changements s'appliquent aux réservations futures et vous sont notifiés. Une fraude entraîne la suspension du compte et la perte des gains non retirés.",
];

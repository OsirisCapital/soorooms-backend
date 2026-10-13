/**
 * Règles d'annulation et de remboursement. Fonctions pures, sans accès à la base.
 * Elles traduisent à l'identique la page « Politique d'annulation et de remboursement » du site
 * (frontend : lib/legal/refunds.ts) : si l'une change, l'autre doit changer.
 */
import { CHECKIN_HOUR } from '../rooms/nap.utils.js';

export type RefundKind = 'NIGHT' | 'NAP' | 'RESIDENCE' | 'HALL';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Le Cameroun est à UTC+1 toute l'année. */
const WAT_OFFSET_HOURS = 1;

export const NIGHT_FULL_REFUND_HOURS = 48;
export const NIGHT_PARTIAL_PERCENT = 50;
export const NAP_FULL_REFUND_HOURS = 3;
export const RESIDENCE_FULL_REFUND_DAYS = 7;
export const RESIDENCE_PARTIAL_PERCENT = 50;
export const HALL_FULL_REFUND_DAYS = 30;
export const HALL_BALANCE_PERCENT = 50;

export type RefundInput = {
  kind: RefundKind;
  /** Date d'arrivée / d'entrée / de l'événement (minuit UTC de la date calendaire). */
  checkInDate: Date;
  napStartHour?: number | null;
  now: Date;
  actor: 'TRAVELER' | 'HOST';
  /** Séquestre : prix du séjour + frais voyageur. */
  amountHeld: number;
  travelerFee: number;
  hostPayout: number;
  /** Acompte (null = paiement unique). */
  depositAmount: number | null;
  /** Somme réellement encaissée à ce jour (acompte seul, ou total). */
  paid: number;
};

export type RefundDecision =
  | { allowed: false; reason: string }
  | {
      allowed: true;
      refund: number;
      retained: number;
      /** Part de l'argent retenu qui revient à l'hôte (le reste est le revenu de la plateforme). */
      hostPayout: number;
      /** Frais voyageur conservés (0 si remboursés). */
      travelerFeeKept: number;
      percent: number;
      label: string;
    };

/** Instant d'arrivée (heure du Cameroun) : 14 h le jour d'arrivée, ou l'heure de début de la sieste. */
export function arrivalInstant(kind: RefundKind, checkInDate: Date, napStartHour?: number | null): Date {
  const hour = kind === 'NAP' ? (napStartHour ?? CHECKIN_HOUR) : kind === 'HALL' ? 0 : CHECKIN_HOUR;
  return new Date(checkInDate.getTime() + (hour - WAT_OFFSET_HOURS) * HOUR_MS);
}

export function decideRefund(input: RefundInput): RefundDecision {
  const { kind, now, actor, amountHeld, travelerFee, hostPayout, depositAmount, paid } = input;
  if (paid <= 0) return { allowed: true, refund: 0, retained: 0, hostPayout: 0, travelerFeeKept: 0, percent: 0, label: 'Rien n’a été payé.' };

  // Annulation par l'hôte : tout est rendu, frais de service compris.
  if (actor === 'HOST') {
    return { allowed: true, refund: paid, retained: 0, hostPayout: 0, travelerFeeKept: 0, percent: 100, label: 'Annulation par l’hôte : remboursement intégral.' };
  }

  const arrival = arrivalInstant(kind, input.checkInDate, input.napStartHour);
  const msBefore = arrival.getTime() - now.getTime();
  if (msBefore < 0) {
    return {
      allowed: false,
      reason: 'La date d’arrivée est passée : écrivez-nous via « Aide et support » ou ouvrez un litige, nous examinerons la situation.',
    };
  }

  // Parts du séjour (hors frais) payées, réparties entre acompte et solde.
  const stay = Math.max(amountHeld - travelerFee, 0);
  const stayShare = amountHeld > 0 ? stay / amountHeld : 1;
  const paidStay = paid * stayShare;
  const depositStay = depositAmount != null ? Math.min(depositAmount, paid) * stayShare : paidStay;
  const balanceStay = Math.max(paidStay - depositStay, 0);

  let depositRatio = 0;
  let balanceRatio = 0;
  let label = '';
  switch (kind) {
    case 'NIGHT':
      if (msBefore > NIGHT_FULL_REFUND_HOURS * HOUR_MS) { depositRatio = balanceRatio = 1; label = 'Plus de 48 h avant l’arrivée : remboursement intégral.'; }
      else { depositRatio = balanceRatio = NIGHT_PARTIAL_PERCENT / 100; label = 'Moins de 48 h avant l’arrivée : 50 % du séjour remboursé.'; }
      break;
    case 'NAP':
      if (msBefore >= NAP_FULL_REFUND_HOURS * HOUR_MS) { depositRatio = balanceRatio = 1; label = 'Au moins 3 h avant la sieste : remboursement intégral.'; }
      else label = 'Moins de 3 h avant la sieste : pas de remboursement.';
      break;
    case 'RESIDENCE':
      if (msBefore >= RESIDENCE_FULL_REFUND_DAYS * DAY_MS) { depositRatio = balanceRatio = 1; label = 'Au moins 7 jours avant l’entrée : remboursement intégral.'; }
      else { depositRatio = balanceRatio = RESIDENCE_PARTIAL_PERCENT / 100; label = 'Moins de 7 jours avant l’entrée : 50 % du forfait remboursé.'; }
      break;
    case 'HALL':
      if (msBefore >= HALL_FULL_REFUND_DAYS * DAY_MS) { depositRatio = balanceRatio = 1; label = 'Au moins 30 jours avant l’événement : remboursement intégral.'; }
      else { depositRatio = 0; balanceRatio = HALL_BALANCE_PERCENT / 100; label = 'Moins de 30 jours avant l’événement : l’acompte n’est pas remboursé, le solde payé l’est à 50 %.'; }
      break;
  }

  const full = depositRatio === 1 && balanceRatio === 1;
  const refundedStay = depositStay * depositRatio + balanceStay * balanceRatio;
  const retainedStay = paidStay - refundedStay;
  const feePaid = paid - paidStay;

  const refund = full ? paid : Math.round(refundedStay);
  const retained = paid - refund;
  const travelerFeeKept = full ? 0 : Math.round(feePaid);
  const host = stay > 0 ? Math.min(Math.round((retainedStay * hostPayout) / stay), retained) : 0;
  return { allowed: true, refund, retained, hostPayout: host, travelerFeeKept, percent: paid > 0 ? Math.round((refund / paid) * 100) : 0, label };
}

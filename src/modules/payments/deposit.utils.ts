/**
 * Paiement en deux temps d'une salle de fêtes : un acompte pour bloquer la date, le solde avant
 * l'événement. Fonctions pures, sans accès à la base.
 */
export const HALL_DEPOSIT_PERCENT = 30;
/** Le solde est dû ce nombre de jours avant l'événement. */
export const BALANCE_DUE_DAYS = 7;
/** Il faut au moins ce délai entre l'acompte et l'échéance du solde, sinon on paie tout d'un coup. */
const MIN_GAP_MS = 24 * 3_600_000;
const DAY_MS = 24 * 3_600_000;

export type PaymentPlan = { depositAmount: number; balanceDueAt: Date } | null;

/** null = paiement unique (pas d'acompte voulu, ou événement trop proche pour laisser un délai pour le solde). */
export function planPayment(params: { checkInDate: Date; now: Date; depositPercent: number | null | undefined; amountHeld: number }): PaymentPlan {
  const { checkInDate, now, depositPercent, amountHeld } = params;
  if (!depositPercent || depositPercent <= 0 || depositPercent >= 100) return null;
  const balanceDueAt = new Date(checkInDate.getTime() - BALANCE_DUE_DAYS * DAY_MS);
  if (balanceDueAt.getTime() - now.getTime() < MIN_GAP_MS) return null;
  const depositAmount = Math.round((amountHeld * depositPercent) / 100);
  if (depositAmount < 1 || depositAmount >= amountHeld) return null;
  return { depositAmount, balanceDueAt };
}

/** Échéance du solde : 7 jours avant l'événement, mais jamais moins de 24 h après l'acompte, ni après l'événement. */
export function balanceDeadline(checkInDate: Date, now: Date): Date {
  const due = checkInDate.getTime() - BALANCE_DUE_DAYS * DAY_MS;
  return new Date(Math.min(Math.max(due, now.getTime() + MIN_GAP_MS), checkInDate.getTime()));
}

export type PaymentStage = { kind: 'FULL' | 'DEPOSIT' | 'BALANCE'; amount: number } | null;

/** Quelle somme attend-on maintenant ? null si la réservation n'attend aucun paiement. */
export function nextStage(booking: { status: string }, escrow: { amountHeld: unknown; depositAmount?: unknown }): PaymentStage {
  const total = Number(escrow.amountHeld);
  const deposit = escrow.depositAmount == null ? null : Number(escrow.depositAmount);
  if (booking.status === 'PENDING_PAYMENT') {
    return deposit == null ? { kind: 'FULL', amount: total } : { kind: 'DEPOSIT', amount: deposit };
  }
  if (booking.status === 'DEPOSIT_PAID' && deposit != null) return { kind: 'BALANCE', amount: total - deposit };
  return null;
}

/**
 * Solde non payé à l'échéance : l'acompte reste à l'hôte. On réduit le séquestre à l'acompte, au prorata
 * (commission et frais compris), en gardant amountHeld = hostPayout + platformFee.
 */
export function forfeitedAmounts(escrow: { amountHeld: unknown; hostPayout: unknown; travelerFee: unknown; depositAmount: unknown }) {
  const held = Number(escrow.amountHeld);
  const deposit = Number(escrow.depositAmount);
  const ratio = held > 0 ? deposit / held : 0;
  const hostPayout = Math.round(Number(escrow.hostPayout) * ratio);
  const platformFee = deposit - hostPayout;
  const travelerFee = Math.min(Math.round(Number(escrow.travelerFee) * ratio), platformFee);
  return { amountHeld: deposit, hostPayout, platformFee, travelerFee };
}

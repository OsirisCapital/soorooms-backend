/**
 * Calculs des rapports financiers (admin et hôte). Fonctions pures : elles reçoivent des lignes déjà
 * lues en base et ne touchent à rien. Montants en FCFA.
 *
 * Vocabulaire :
 *  - « encaissé » : argent reçu du voyageur (au moins un paiement réussi), daté du premier paiement ;
 *  - « en séquestre » : encaissé mais pas encore versé à l'hôte (ni remboursé) ;
 *  - « commission gagnée » : commission d'une réservation dont le versement à l'hôte est terminé
 *    (le séquestre est alors libéré) ; avant cela, c'est une commission « en attente ».
 */
import type { EscrowStatus, PayoutStatus } from '../../prisma/client.js';
import { bucketByDay, dayKey, windowStart } from '../admin/stats.utils.js';

export type FinanceRow = {
  escrowId: string;
  bookingId: string;
  propertyId: string;
  propertyTitle: string;
  city: string;
  roomName: string;
  /** Date du premier paiement réussi. */
  paidAt: Date;
  /** Date de sortie du séquestre (versement terminé ou remboursement) ; null tant que l'argent est retenu. */
  closedAt: Date | null;
  status: EscrowStatus;
  bookingStatus: string;
  method: string | null;
  amount: number;
  fee: number;
  net: number;
  payoutStatus: PayoutStatus | null;
};

type Sum = { count: number; amount: number };
const sum = (rows: FinanceRow[], pick: (row: FinanceRow) => number) => rows.reduce((total, row) => total + pick(row), 0);
const tally = (rows: FinanceRow[], pick: (row: FinanceRow) => number): Sum => ({ count: rows.length, amount: sum(rows, pick) });

export function buildReport(
  rows: readonly FinanceRow[],
  keys: readonly string[],
  /** Ce que la série « réalisé » additionne : la commission (plateforme) ou le net versé (hôte). */
  settledValue: 'fee' | 'net',
) {
  const since = windowStart(keys[0]);
  const inWindow = (date: Date | null) => !!date && date >= since;

  const paid = rows.filter((row) => inWindow(row.paidAt));
  const released = rows.filter((row) => row.status === 'RELEASED_TO_HOST' && inWindow(row.closedAt));
  const refunded = rows.filter((row) => row.status === 'REFUNDED_TO_TRAVELER' && inWindow(row.closedAt));
  const held = rows.filter((row) => row.status === 'HELD_IN_ESCROW');
  const disputed = held.filter((row) => row.bookingStatus === 'DISPUTED');
  const withPayout = (status: PayoutStatus[]) => held.filter((row) => row.payoutStatus && status.includes(row.payoutStatus));

  const byMethod = new Map<string, Sum>();
  for (const row of paid) {
    const key = row.method ?? 'INCONNU';
    const current = byMethod.get(key) ?? { count: 0, amount: 0 };
    byMethod.set(key, { count: current.count + 1, amount: current.amount + row.amount });
  }

  const byProperty = new Map<string, { propertyId: string; title: string; city: string; bookings: number; amount: number; fee: number; net: number }>();
  for (const row of paid) {
    const current = byProperty.get(row.propertyId) ?? { propertyId: row.propertyId, title: row.propertyTitle, city: row.city, bookings: 0, amount: 0, fee: 0, net: 0 };
    current.bookings += 1;
    current.amount += row.amount;
    current.fee += row.fee;
    current.net += row.net;
    byProperty.set(row.propertyId, current);
  }

  const lines = [...paid]
    .sort((a, b) => b.paidAt.getTime() - a.paidAt.getTime())
    .slice(0, 500)
    .map((row) => ({
      date: dayKey(row.paidAt),
      bookingId: row.bookingId,
      property: row.propertyTitle,
      city: row.city,
      room: row.roomName,
      amount: row.amount,
      fee: row.fee,
      net: row.net,
      escrowStatus: row.status,
      payoutStatus: row.payoutStatus,
    }));

  return {
    days: [...keys],
    period: {
      collected: sum(paid, (r) => r.amount),
      bookings: paid.length,
      commissionEarned: sum(released, (r) => r.fee),
      hostNetReleased: sum(released, (r) => r.net),
      refunded: sum(refunded, (r) => r.amount),
      refundedCount: refunded.length,
    },
    now: {
      held: sum(held, (r) => r.amount),
      heldFee: sum(held, (r) => r.fee),
      heldNet: sum(held, (r) => r.net),
      disputedCount: disputed.length,
      disputedAmount: sum(disputed, (r) => r.amount),
    },
    payouts: {
      toSend: tally(withPayout(['TO_SEND']), (r) => r.net),
      inFlight: tally(withPayout(['SENDING', 'PROCESSING']), (r) => r.net),
      failed: tally(withPayout(['FAILED']), (r) => r.net),
      paid: tally(released, (r) => r.net),
    },
    series: {
      collected: bucketByDay(paid.map((r) => ({ date: r.paidAt, value: r.amount })), keys),
      settled: bucketByDay(
        released.map((r) => ({ date: r.closedAt as Date, value: settledValue === 'fee' ? r.fee : r.net })),
        keys,
      ),
    },
    byMethod: [...byMethod.entries()].map(([method, value]) => ({ method, ...value })).sort((a, b) => b.amount - a.amount),
    byProperty: [...byProperty.values()].sort((a, b) => b.amount - a.amount),
    lines,
  };
}

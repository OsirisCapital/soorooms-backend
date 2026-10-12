/** Reçu voyageur : données figées au paiement, sans calcul de commission côté client. */
export type Receipt = {
  reference: string;
  issuedAt: Date;
  travelerName: string;
  /** Occupant, quand il diffère du payeur. */
  guestName: string | null;
  currency: string;
  property: { title: string; city: string; quarter: string };
  roomName: string;
  checkInDate: Date;
  checkOutDate: Date;
  nights: number;
  stayPrice: number;
  travelerFee: number;
  travelerFeePercent: number | null;
  totalPaid: number;
  paymentMethod: string;
  refunded: boolean;
  /** Résidence étudiante : forfait réservé (SEMESTER ou YEAR), null pour un séjour classique. */
  stayTerm: string | null;
  /** Paiement en deux temps (salle de fêtes) : ce qu'il reste à payer (0 si tout est réglé) et son échéance. */
  balanceDue: number;
  balanceDueAt: Date | null;
  /** Facture entreprise, une fois demandée par le voyageur ; sinon null (simple reçu). */
  invoice: { number: string; company: string; address: string; taxId: string | null; issuedAt: Date } | null;
};

/** Référence lisible, stable et unique par réservation (ex. SR-3F9A1C2B). */
export function receiptReference(bookingId: string): string {
  return `SR-${bookingId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

export function countNights(checkIn: Date, checkOut: Date): number {
  return Math.max(1, Math.round((checkOut.getTime() - checkIn.getTime()) / 86_400_000));
}

/** Numéro de facture : même racine que la référence du reçu (ex. FA-3F9A1C2B). */
export function invoiceNumber(bookingId: string): string {
  return `FA-${bookingId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

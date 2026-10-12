/** Reçu voyageur : données figées au paiement, sans calcul de commission côté client. */
export type Receipt = {
  reference: string;
  issuedAt: Date;
  travelerName: string;
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
};

/** Référence lisible, stable et unique par réservation (ex. SR-3F9A1C2B). */
export function receiptReference(bookingId: string): string {
  return `SR-${bookingId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

export function countNights(checkIn: Date, checkOut: Date): number {
  return Math.max(1, Math.round((checkOut.getTime() - checkIn.getTime()) / 86_400_000));
}

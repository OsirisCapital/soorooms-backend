import { randomInt } from 'node:crypto';
import { countNights, receiptReference } from './receipt.js';

/** Statuts d'une réservation payée : seule une réservation payée peut être attestée. */
export const ATTESTABLE_STATUSES = ['CONFIRMED_ESCROW', 'COMPLETED'] as const;

// Sans 0/O, 1/I/L : le code se lit et se recopie sans ambiguïté.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 10;

export function generateAttestationCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

/** Accepte « ab12-cd34ef », « SR ab12… » ou minuscules : ne garde que les caractères du code. */
export function normalizeAttestationCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Mots désignant le Cameroun, sans accents ni casse : l'attestation vise les voyageurs venant de l'étranger. */
const CAMEROON = new Set(['cameroun', 'cameroon', 'camerun', 'cm', 'cmr']);

export function isForeignCountry(country: string): boolean {
  const clean = country
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
  return clean.length >= 2 && !CAMEROON.has(clean);
}

/** Raisons pour lesquelles une attestation ne peut pas (encore) être demandée ; vide = éligible. */
export function attestationBlockers(input: { status: string; travelerKycStatus: string }): string[] {
  const reasons: string[] = [];
  if (!(ATTESTABLE_STATUSES as readonly string[]).includes(input.status)) {
    reasons.push('La réservation doit être payée et confirmée.');
  }
  if (input.travelerKycStatus !== 'APPROVED') {
    reasons.push("Votre identité doit être vérifiée (KYC) avant de demander une attestation.");
  }
  return reasons;
}

export type AttestationSource = {
  id: string;
  status: string;
  checkInDate: Date;
  checkOutDate: Date;
  guestName: string | null;
  traveler: { fullName: string };
  room: { name: string; property: { title: string; city: string; quarter: string } };
  attestationCode: string | null;
  attestationSignedAt: Date | null;
  attestationSignerName: string | null;
  escrowVault?: { status: string } | null;
};

export type Attestation = {
  code: string;
  bookingReference: string;
  signedAt: Date;
  signerName: string;
  occupantName: string;
  payerName: string;
  property: { title: string; city: string; quarter: string };
  roomName: string;
  checkInDate: Date;
  checkOutDate: Date;
  nights: number;
  /** Faux si la réservation a été annulée ou remboursée depuis la signature. */
  valid: boolean;
};

export function buildAttestation(b: AttestationSource): Attestation | null {
  if (!b.attestationCode || !b.attestationSignedAt || !b.attestationSignerName) return null;
  const paid = (ATTESTABLE_STATUSES as readonly string[]).includes(b.status);
  return {
    code: b.attestationCode,
    bookingReference: receiptReference(b.id),
    signedAt: b.attestationSignedAt,
    signerName: b.attestationSignerName,
    occupantName: b.guestName ?? b.traveler.fullName,
    payerName: b.traveler.fullName,
    property: b.room.property,
    roomName: b.room.name,
    checkInDate: b.checkInDate,
    checkOutDate: b.checkOutDate,
    nights: countNights(b.checkInDate, b.checkOutDate),
    valid: paid && b.escrowVault?.status !== 'REFUNDED_TO_TRAVELER',
  };
}

/** Ce que n'importe qui peut voir en vérifiant un code : pas de prix, pas de téléphone, pas de payeur. */
export function toPublicVerification(a: Attestation) {
  return {
    valid: a.valid,
    code: a.code,
    occupantName: a.occupantName,
    property: a.property,
    checkInDate: a.checkInDate,
    checkOutDate: a.checkOutDate,
    nights: a.nights,
    signedAt: a.signedAt,
    signerName: a.signerName,
  };
}

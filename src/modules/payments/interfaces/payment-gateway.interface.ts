/**
 * Contrat générique de passerelle de paiement. Toute la logique métier
 * (PaymentsService) ne parle qu'à cette interface, jamais directement à
 * l'API d'un agrégateur — le jour où on ajoute CinetPay en complément ou
 * en remplacement de Notch Pay, seule une nouvelle classe qui implémente
 * cette interface est nécessaire, PaymentsService ne bouge pas.
 */
import type { PaymentMethod } from '../../../prisma/client.js';

export interface InitiatePaymentParams {
  amount: number;
  currency: string;
  /** Référence interne (ici : l'id de la Booking) transmise à l'agrégateur. */
  reference: string;
  description: string;
}

export interface InitiatePaymentResult {
  /** URL vers laquelle rediriger le voyageur pour finaliser le paiement. */
  paymentUrl: string;
  /** Référence de transaction côté agrégateur — devient Transaction.paymentGatewayRef. */
  gatewayRef: string;
}

export interface ReleaseFundsParams {
  amount: number;
  /** Référence interne (ici : l'id de la Booking). */
  reference: string;
}

export interface ReleaseFundsResult {
  payoutRef: string;
}

/** Forme normalisée d'un événement de webhook, indépendante de l'agrégateur. */
export interface NormalizedWebhookEvent {
  gatewayRef: string;
  status: 'SUCCESS' | 'FAILED' | 'PENDING';
  amount: number;
  paymentMethod: PaymentMethod;
  /** La référence qu'on avait transmise à l'initiation — permet de
   *  retrouver la Booking/EscrowVault concernée. */
  bookingReference: string;
}

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

export interface PaymentGateway {
  initiatePayment(params: InitiatePaymentParams): Promise<InitiatePaymentResult>;
  /** Déclenche le reversement effectif à l'hôte (90% du montant) après la
   *  double validation — voir BookingsService.maybeComplete et
   *  PaymentsService.releaseEscrow. */
  releaseFunds(params: ReleaseFundsParams): Promise<ReleaseFundsResult>;
  /** Vérifie l'authenticité d'un webhook — doit être timing-safe. */
  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean;
  parseWebhookPayload(rawBody: Buffer): NormalizedWebhookEvent;
}

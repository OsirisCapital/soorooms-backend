/**
 * Contrat générique de passerelle de paiement. Toute la logique métier
 * (PaymentsService) ne parle qu'à cette interface, jamais directement à
 * l'API d'un agrégateur — le jour où on ajoute CinetPay en complément ou
 * en remplacement de Notch Pay, seule une nouvelle classe qui implémente
 * cette interface est nécessaire, PaymentsService ne bouge pas.
 */
import type { PaymentMethod } from '../../../prisma/client.js';

/** Le payeur, tel que l'agrégateur doit le connaître (au moins un téléphone ou un e-mail). */
export interface PaymentCustomer {
  name: string;
  phone?: string;
  email?: string;
}

export interface InitiatePaymentParams {
  amount: number;
  currency: string;
  /**
   * Référence unique de CETTE tentative de paiement, au format
   * « <id de la réservation>_<suffixe> ». Une même réservation peut avoir
   * plusieurs tentatives (échec puis nouvel essai) : l'agrégateur exige une
   * référence unique par paiement, d'où le suffixe. L'identifiant de la
   * réservation en est extrait au retour du webhook.
   */
  reference: string;
  description: string;
  customer: PaymentCustomer;
  /** Page du frontend sur laquelle le voyageur est ramené après le paiement. */
  callbackUrl: string;
}

export interface InitiatePaymentResult {
  /** URL vers laquelle rediriger le voyageur pour finaliser le paiement. */
  paymentUrl: string;
  /** Référence de transaction côté agrégateur — devient Transaction.paymentGatewayId. */
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
  /** L'identifiant de la réservation, extrait de la référence qu'on avait
   *  transmise à l'initiation — permet de retrouver le séquestre concerné. */
  bookingReference: string;
}

/** État d'un paiement tel que l'agrégateur le déclare quand on l'interroge directement. */
export interface VerifiedPayment {
  status: 'SUCCESS' | 'FAILED' | 'PENDING';
  amount: number;
  currency: string;
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
  /**
   * Normalise un webhook. Renvoie `null` pour un événement qui ne concerne
   * pas un paiement de réservation (reversement, client créé…) : il est alors
   * acquitté sans aucun effet.
   */
  parseWebhookPayload(rawBody: Buffer): NormalizedWebhookEvent | null;
  /**
   * Interroge directement l'agrégateur sur un paiement. Un webhook seul ne
   * suffit pas à débloquer une réservation : on recoupe toujours son contenu
   * avec la réponse de l'API avant de confirmer.
   */
  verifyPayment(gatewayRef: string): Promise<VerifiedPayment>;
}

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

/** Canal Mobile Money d'un versement (codes Notch Pay pour le Cameroun). */
export type PayoutChannel = 'cm.mtn' | 'cm.orange';

export interface SendTransferParams {
  amount: number;
  currency: 'XAF';
  /** Unique par tentative : l'agrégateur refuse deux fois la même référence, ce qui empêche un double envoi. */
  reference: string;
  description: string;
  beneficiary: { name: string; phone: string; channel: PayoutChannel };
}

/** État d'un transfert tel que l'agrégateur le déclare. */
export interface TransferState {
  status: 'COMPLETE' | 'FAILED' | 'PENDING';
  /** Identifiant du transfert chez l'agrégateur. */
  gatewayRef: string;
  /** Notre référence, telle que l'agrégateur la renvoie. */
  reference: string;
  /** Motif d'échec lisible, quand l'agrégateur en donne un. */
  failureReason?: string;
  amount?: number;
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
  /** Référence canonique du paiement chez l'agrégateur : la même que celle des webhooks, pour que
   *  les deux chemins (notification et retour du voyageur) reconnaissent un même paiement. */
  gatewayRef: string;
  /** Réservation à laquelle ce paiement se rattache, d'après la référence qu'on avait transmise à
   *  l'initiation ; absente si aucune référence reconnaissable n'a été trouvée. */
  bookingReference?: string;
  paymentMethod: PaymentMethod;
  /** Réponse brute de l'agrégateur, conservée pour l'audit. */
  raw: unknown;
}

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

export interface PaymentGateway {
  initiatePayment(params: InitiatePaymentParams): Promise<InitiatePaymentResult>;
  /**
   * Envoie de l'argent à l'hôte (Mobile Money). Appelée uniquement par PayoutsService, après la
   * validation de la finance.
   */
  sendTransfer(params: SendTransferParams): Promise<TransferState>;
  /** Relit un transfert par notre référence ; `null` si l'agrégateur ne le connaît pas (jamais envoyé). */
  getTransfer(reference: string): Promise<TransferState | null>;
  /** Normalise un webhook de transfert ; `null` si l'événement n'en est pas un. */
  parseTransferWebhook(rawBody: Buffer): { reference: string } | null;
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

/**
 * Implémentation Notch Pay — VOLONTAIREMENT INCOMPLÈTE.
 *
 * Tant que le compte sandbox n'existe pas, cette classe ne peut pas être
 * finalisée : ni la forme exacte du payload de webhook, ni l'algorithme
 * précis de signature, ni les champs de l'API d'initiation ne sont encore
 * connus avec certitude. C'est le SEUL fichier à modifier une fois les
 * identifiants et la documentation Notch Pay en main — PaymentsService et
 * le contrôleur n'ont besoin d'aucun changement.
 *
 * Documentation à consulter à ce moment-là : https://developer.notchpay.co
 */
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../../../config/configuration.js';
import type {
  InitiatePaymentParams,
  InitiatePaymentResult,
  NormalizedWebhookEvent,
  PaymentGateway,
  ReleaseFundsParams,
  ReleaseFundsResult,
} from '../interfaces/payment-gateway.interface.js';
import type { PaymentMethod } from '../../../prisma/client.js';

@Injectable()
export class NotchPayGateway implements PaymentGateway {
  constructor(private readonly configService: ConfigService<AppConfig, true>) {}

  async initiatePayment(_params: InitiatePaymentParams): Promise<InitiatePaymentResult> {
    const apiKey = this.configService.get('payment.aggregatorApiKey', { infer: true });
    if (!apiKey) {
      throw new ServiceUnavailableException(
        "Le paiement n'est pas encore configuré (PAYMENT_AGGREGATOR_API_KEY manquant). " +
          "Ajoutez vos identifiants sandbox Notch Pay dans .env pour activer cette route.",
      );
    }

    // TODO (une fois les identifiants obtenus) : appel réel à l'API Notch
    // Pay d'initiation de paiement (endpoint, en-têtes et forme exacte du
    // corps à confirmer avec la documentation officielle), puis retourner
    // { paymentUrl, gatewayRef } à partir de sa réponse.
    throw new ServiceUnavailableException("Intégration Notch Pay pas encore implémentée.");
  }

  async releaseFunds(_params: ReleaseFundsParams): Promise<ReleaseFundsResult> {
    const apiKey = this.configService.get('payment.aggregatorApiKey', { infer: true });
    if (!apiKey) {
      throw new ServiceUnavailableException(
        "Le reversement à l'hôte n'est pas encore configuré (PAYMENT_AGGREGATOR_API_KEY manquant).",
      );
    }

    // TODO (une fois les identifiants obtenus) : appel réel à l'API Notch
    // Pay de transfert/reversement (endpoint "payout" ou équivalent selon
    // leur documentation), puis retourner { payoutRef }.
    throw new ServiceUnavailableException('Reversement Notch Pay pas encore implémenté.');
  }

  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
    const secret = this.configService.get('payment.webhookSigningSecret', { infer: true });
    if (!secret || !signatureHeader) {
      return false;
    }

    // Point de départ standard (HMAC-SHA256 du corps brut) — à ajuster
    // précisément sur l'algorithme réel documenté par Notch Pay (nom de
    // l'en-tête, encodage attendu) une fois connu. Comparaison
    // timing-safe conservée dans tous les cas : ne jamais comparer des
    // signatures avec ===, ça ouvre une faille de timing attack.
    const computed = createHmac('sha256', secret).update(rawBody).digest('hex');
    const provided = Buffer.from(signatureHeader);
    const expected = Buffer.from(computed);
    if (provided.length !== expected.length) {
      return false;
    }
    return timingSafeEqual(provided, expected);
  }

  parseWebhookPayload(rawBody: Buffer): NormalizedWebhookEvent {
    // TODO : adapter aux noms de champs réels une fois la documentation
    // Notch Pay consultée — ceci est une supposition raisonnable, pas une
    // certitude.
    const payload = JSON.parse(rawBody.toString('utf-8'));
    return {
      gatewayRef: payload.reference ?? payload.transaction_id ?? payload.id,
      status: payload.status === 'complete' || payload.status === 'success' ? 'SUCCESS'
        : payload.status === 'failed' ? 'FAILED'
        : 'PENDING',
      amount: Number(payload.amount),
      paymentMethod: 'MTN_MOMO' as PaymentMethod,
      bookingReference: payload.metadata?.bookingId ?? payload.reference,
    };
  }
}

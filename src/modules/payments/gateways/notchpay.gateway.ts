/**
 * Passerelle Notch Pay (https://developer.notchpay.co).
 *
 *  - Création d'un paiement : POST /payments, en-tête `Authorization: <clé publique>`.
 *    Le voyageur est ensuite redirigé vers `authorization_url` (page de paiement
 *    hébergée par Notch Pay, où il choisit MTN, Orange ou carte).
 *  - Notifications : webhook signé en HMAC-SHA256 avec la « Hash Key », en-tête
 *    `x-notch-signature`.
 *  - Vérification : GET /payments/{référence}. Un webhook, même correctement
 *    signé, n'est JAMAIS suffisant seul pour confirmer une réservation : on
 *    recoupe toujours avec cette lecture directe (voir PaymentsService).
 *
 * Le reversement aux hôtes (Transfers API) n'est pas encore branché : il faut
 * d'abord savoir sur quel numéro et quel opérateur payer chaque hôte, donnée
 * que le modèle ne contient pas encore.
 */
import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../../../config/configuration.js';
import type { PaymentMethod } from '../../../prisma/client.js';
import type {
  InitiatePaymentParams,
  InitiatePaymentResult,
  NormalizedWebhookEvent,
  PaymentGateway,
  ReleaseFundsParams,
  ReleaseFundsResult,
  VerifiedPayment,
} from '../interfaces/payment-gateway.interface.js';

const API_BASE_URL = 'https://api.notchpay.co';
const REQUEST_TIMEOUT_MS = 15_000;

/** UUID de réservation, éventuellement suivi de « _<suffixe> » (voir InitiatePaymentParams.reference). */
const BOOKING_REFERENCE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[0-9a-z]+)?$/i;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Première valeur texte non vide parmi les clés données. */
function pickString(source: unknown, ...keys: string[]): string | undefined {
  if (!isObject(source)) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

@Injectable()
export class NotchPayGateway implements PaymentGateway {
  private readonly logger = new Logger(NotchPayGateway.name);

  constructor(private readonly configService: ConfigService<AppConfig, true>) {}

  // ---------------------------------------------------------------------
  // Création d'un paiement
  // ---------------------------------------------------------------------

  async initiatePayment(params: InitiatePaymentParams): Promise<InitiatePaymentResult> {
    const customer: Json = { name: params.customer.name };
    if (params.customer.phone) customer.phone = params.customer.phone;
    if (params.customer.email) customer.email = params.customer.email;

    const json = await this.request('POST', '/payments', {
      amount: Math.round(params.amount), // le FCFA n'a pas de décimales
      currency: params.currency,
      reference: params.reference,
      description: params.description,
      callback: params.callbackUrl,
      customer,
    });

    const transaction = json.transaction;
    const gatewayRef =
      typeof transaction === 'string' && transaction !== ''
        ? transaction
        : pickString(transaction, 'reference', 'id');
    const paymentUrl = pickString(json, 'authorization_url');

    if (!gatewayRef || !paymentUrl) {
      this.logger.error(`Réponse Notch Pay inattendue à la création d'un paiement : ${JSON.stringify(json).slice(0, 500)}`);
      throw new BadGatewayException('Le service de paiement a renvoyé une réponse inattendue.');
    }
    return { paymentUrl, gatewayRef };
  }

  // ---------------------------------------------------------------------
  // Lecture directe d'un paiement (recoupement des webhooks)
  // ---------------------------------------------------------------------

  async verifyPayment(gatewayRef: string): Promise<VerifiedPayment> {
    const json = await this.request('GET', `/payments/${encodeURIComponent(gatewayRef)}`);
    const transaction = json.transaction;
    if (!isObject(transaction)) {
      this.logger.error(`Lecture du paiement ${gatewayRef} : réponse inattendue ${JSON.stringify(json).slice(0, 500)}`);
      throw new BadGatewayException('Le service de paiement a renvoyé une réponse inattendue.');
    }
    return {
      status: this.statusFrom('', pickString(transaction, 'status')),
      amount: Number(transaction.amount),
      currency: (pickString(transaction, 'currency') ?? '').toUpperCase(),
    };
  }

  // ---------------------------------------------------------------------
  // Webhooks
  // ---------------------------------------------------------------------

  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
    const { hashKey } = this.keys();
    if (!hashKey) {
      this.logger.error('Webhook reçu mais NOTCHPAY_HASH_KEY est absente : impossible de vérifier la signature.');
      return false;
    }
    if (!signatureHeader) return false;

    // Signature attendue : HMAC-SHA256 hexadécimal du corps BRUT de la requête.
    const provided = signatureHeader.trim().replace(/^sha256=/i, '');
    if (!/^[0-9a-f]{64}$/i.test(provided)) return false;

    const expected = createHmac('sha256', hashKey).update(rawBody).digest();
    // Comparaison en temps constant : jamais `===` sur une signature.
    return timingSafeEqual(Buffer.from(provided, 'hex'), expected);
  }

  parseWebhookPayload(rawBody: Buffer): NormalizedWebhookEvent | null {
    let event: unknown;
    try {
      event = JSON.parse(rawBody.toString('utf-8'));
    } catch {
      throw new BadRequestException('Webhook Notch Pay illisible (JSON invalide).');
    }

    const type = pickString(event, 'type', 'event') ?? '';
    // Transferts, clients… : sans effet sur les paiements de réservation.
    if (!type.startsWith('payment.')) return null;

    const root = isObject(event) && isObject(event.data) ? event.data : {};
    const data = isObject(root.transaction) ? root.transaction : root;

    // Notre référence peut se trouver dans plusieurs champs selon la version
    // du payload : on cherche celle qui a la forme « <id réservation>[_suffixe] ».
    const candidates = ['merchant_reference', 'reference', 'trxref', 'id']
      .map((key) => pickString(data, key))
      .filter((value): value is string => value !== undefined);
    const ours = candidates.map((value) => BOOKING_REFERENCE.exec(value)).find((match) => match !== null);

    if (!ours) {
      this.logger.error(
        `Webhook Notch Pay « ${type} » sans référence de réservation reconnaissable : ${rawBody.toString('utf-8').slice(0, 800)}`,
      );
      throw new BadRequestException('Référence de paiement non reconnue.');
    }

    const gatewayRef = pickString(data, 'reference', 'id') ?? candidates[0];
    const paymentMethod = this.methodFrom(
      pickString(data, 'channel', 'payment_channel') ??
        (isObject(data.payment_method) ? pickString(data.payment_method, 'channel', 'type') : undefined),
    );

    return {
      gatewayRef,
      status: this.statusFrom(type, pickString(data, 'status')),
      amount: Number(data.amount),
      paymentMethod,
      bookingReference: ours[1].toLowerCase(),
    };
  }

  // ---------------------------------------------------------------------
  // Reversement aux hôtes — pas encore branché
  // ---------------------------------------------------------------------

  async releaseFunds(params: ReleaseFundsParams): Promise<ReleaseFundsResult> {
    this.logger.error(
      `Reversement demandé pour la réservation ${params.reference} (${params.amount} FCFA) mais non implémenté : ` +
        "il manque le numéro et l'opérateur de paiement de l'hôte, et l'appel à l'API Transfers de Notch Pay.",
    );
    throw new ServiceUnavailableException("Le reversement automatique à l'hôte n'est pas encore disponible.");
  }

  // ---------------------------------------------------------------------
  // Aides internes
  // ---------------------------------------------------------------------

  private keys() {
    return this.configService.get('payment.notchpay', { infer: true });
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Json> {
    const { publicKey } = this.keys();
    if (!publicKey) {
      this.logger.error('NOTCHPAY_PUBLIC_KEY est absente : aucun appel à Notch Pay possible.');
      throw new ServiceUnavailableException("Le paiement n'est pas encore disponible.");
    }

    let response: Response;
    try {
      response = await fetch(`${API_BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: publicKey,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.error(`Notch Pay injoignable (${method} ${path}) : ${error instanceof Error ? error.message : String(error)}`);
      throw new BadGatewayException('Le service de paiement ne répond pas. Réessayez dans un instant.');
    }

    const text = await response.text();
    let json: Json = {};
    try {
      const parsed: unknown = text === '' ? {} : JSON.parse(text);
      if (isObject(parsed)) json = parsed;
    } catch {
      // corps non JSON : géré ci-dessous selon le statut
    }

    if (!response.ok) {
      this.logger.error(`Notch Pay a répondu ${response.status} (${method} ${path}) : ${text.slice(0, 500)}`);
      if (response.status === 401 || response.status === 403) {
        // Clé refusée : problème de configuration, pas de l'utilisateur.
        throw new ServiceUnavailableException('Le paiement est momentanément indisponible.');
      }
      if (response.status === 404) throw new NotFoundException('Paiement introuvable chez Notch Pay.');
      throw new BadGatewayException('Le service de paiement a refusé la requête.');
    }
    return json;
  }

  private statusFrom(type: string, status?: string): 'SUCCESS' | 'FAILED' | 'PENDING' {
    const t = type.toLowerCase();
    const s = (status ?? '').toLowerCase();
    // Un échec déclaré à un endroit l'emporte : on ne confirme jamais un
    // paiement dont une des deux indications est négative.
    if (['failed', 'canceled', 'cancelled', 'expired'].includes(s)) return 'FAILED';
    if (['payment.failed', 'payment.canceled', 'payment.expired'].includes(t)) return 'FAILED';
    if (t === 'payment.complete' || ['complete', 'completed', 'success'].includes(s)) return 'SUCCESS';
    return 'PENDING';
  }

  private methodFrom(channel: string | undefined): PaymentMethod {
    const c = (channel ?? '').toLowerCase();
    if (c.includes('orange')) return 'ORANGE_MONEY' as PaymentMethod;
    if (c.includes('card') || c.includes('visa') || c.includes('master')) return 'CREDIT_CARD' as PaymentMethod;
    if (c.includes('mtn')) return 'MTN_MOMO' as PaymentMethod;
    this.logger.warn(`Canal Notch Pay non reconnu (« ${channel ?? 'absent'} ») : enregistré comme MTN_MOMO par défaut.`);
    return 'MTN_MOMO' as PaymentMethod;
  }
}

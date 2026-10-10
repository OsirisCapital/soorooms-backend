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
 *  - Versement aux hôtes : POST /transfers (Transfers API). Cet appel exige, en plus de la clé
 *    publique, la clé PRIVÉE dans l'en-tête `X-Grant` (variable NOTCHPAY_PRIVATE_KEY), et
 *    l'adresse IP du serveur doit être autorisée dans le tableau de bord Notch Pay.
 */
import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
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
  SendTransferParams,
  TransferState,
  VerifiedPayment,
} from '../interfaces/payment-gateway.interface.js';

const DEFAULT_API_URL = 'https://api.notchpay.co';
const REQUEST_TIMEOUT_MS = 15_000;

/** UUID de réservation, éventuellement suivi de « _<suffixe> » (voir InitiatePaymentParams.reference). */
const BOOKING_REFERENCE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[0-9a-z]+)?$/i;

type Json = Record<string, unknown>;

/**
 * Notre référence peut se trouver dans plusieurs champs selon la version du payload : on cherche
 * celle qui a la forme « <id réservation>[_suffixe] ». Même règle pour les webhooks et pour la
 * lecture directe d'un paiement.
 */
function findBookingReference(data: unknown): { candidates: string[]; bookingId?: string } {
  const candidates = ['merchant_reference', 'reference', 'trxref', 'id']
    .map((key) => pickString(data, key))
    .filter((value): value is string => value !== undefined);
  const match = candidates.map((value) => BOOKING_REFERENCE.exec(value)).find((m) => m !== null);
  return { candidates, bookingId: match ? match[1].toLowerCase() : undefined };
}

/** Notch Pay a refusé le numéro de téléphone du client (« must be a valid number »). */
class PhoneRejectedError extends Error {}

/** La réponse 422 de Notch Pay désigne-t-elle un problème de numéro de téléphone ? */
function mentionsPhone(json: Json): boolean {
  const errors = isObject(json.errors) ? json.errors : {};
  return Object.keys(errors).some((key) => /phone/i.test(key));
}

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
    try {
      return await this.createPayment(params, params.customer);
    } catch (error) {
      if (!(error instanceof PhoneRejectedError)) throw error;

      // Notch Pay valide le numéro avec ses propres règles : un numéro bien formé mais inexistant est
      // refusé. Ce numéro n'est qu'une information de contact (le voyageur saisit lui-même celui avec
      // lequel il paie, sur la page de Notch Pay) : l'adresse e-mail suffit.
      if (params.customer.email) {
        this.logger.warn("Numéro refusé par Notch Pay : nouvel essai avec l'adresse e-mail seule.");
        try {
          return await this.createPayment(params, { ...params.customer, phone: undefined });
        } catch (retryError) {
          if (retryError instanceof PhoneRejectedError) throw this.phoneRejected();
          throw retryError;
        }
      }
      throw this.phoneRejected();
    }
  }

  private phoneRejected() {
    return new UnprocessableEntityException(
      "Le service de paiement ne reconnaît pas votre numéro de téléphone. Ajoutez une adresse e-mail à votre compte (« Mes informations » dans votre profil), puis réessayez.",
    );
  }

  private async createPayment(params: InitiatePaymentParams, who: InitiatePaymentParams['customer']): Promise<InitiatePaymentResult> {
    const customer: Json = { name: who.name };
    if (who.phone) customer.phone = who.phone;
    if (who.email) customer.email = who.email;

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
    const { candidates, bookingId } = findBookingReference(transaction);
    return {
      status: this.statusFrom('', pickString(transaction, 'status')),
      amount: Number(transaction.amount),
      currency: (pickString(transaction, 'currency') ?? '').toUpperCase(),
      gatewayRef: pickString(transaction, 'reference', 'id') ?? candidates[0] ?? gatewayRef,
      bookingReference: bookingId,
      paymentMethod: this.methodFrom(
        pickString(transaction, 'channel', 'payment_channel') ??
          (isObject(transaction.payment_method) ? pickString(transaction.payment_method, 'channel', 'type') : undefined),
      ),
      raw: transaction,
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

    const { candidates, bookingId } = findBookingReference(data);

    if (!bookingId) {
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
      bookingReference: bookingId,
    };
  }

  // ---------------------------------------------------------------------
  // Versement aux hôtes (Transfers API)
  // ---------------------------------------------------------------------

  async sendTransfer(params: SendTransferParams): Promise<TransferState> {
    // Notch Pay veut l'identifiant d'un bénéficiaire (« ben_… ») : on le crée d'abord. Si cette
    // première étape échoue, RIEN n'a été envoyé : l'échec est donc toujours « sûr » (réessai permis).
    let beneficiaryId: string;
    try {
      const created = await this.request(
        'POST',
        '/beneficiaries',
        {
          name: params.beneficiary.name,
          phone: params.beneficiary.phone,
          country: 'CM',
          currency: params.currency,
          type: 'mobile_money',
          // L'API réelle exige aussi le canal et le numéro de compte (le numéro Mobile Money).
          channel: params.beneficiary.channel,
          account_number: params.beneficiary.phone,
        },
        { grant: true },
      );
      const id = pickString(isObject(created.beneficiary) ? created.beneficiary : created, 'id');
      if (!id) {
        this.logger.error(`Réponse Notch Pay inattendue à la création d'un bénéficiaire : ${JSON.stringify(created).slice(0, 500)}`);
        throw new ServiceUnavailableException("Notch Pay n'a pas créé le bénéficiaire (réponse inattendue).");
      }
      beneficiaryId = id;
    } catch (error) {
      if (error instanceof BadGatewayException) {
        throw new ServiceUnavailableException("Notch Pay n'a pas pu enregistrer le bénéficiaire. Réessayez dans un instant.");
      }
      throw error;
    }

    const json = await this.request(
      'POST',
      '/transfers',
      {
        amount: Math.round(params.amount), // le FCFA n'a pas de décimales
        currency: params.currency,
        channel: params.beneficiary.channel,
        description: params.description,
        reference: params.reference,
        beneficiary: beneficiaryId,
      },
      { grant: true },
    );
    const state = this.transferFrom(json.transfer ?? json);
    if (!state) {
      this.logger.error(`Réponse Notch Pay inattendue à un transfert : ${JSON.stringify(json).slice(0, 500)}`);
      throw new BadGatewayException('Le service de paiement a renvoyé une réponse inattendue.');
    }
    return state;
  }

  async getTransfer(reference: string): Promise<TransferState | null> {
    try {
      const json = await this.request('GET', `/transfers/${encodeURIComponent(reference)}`, undefined, { grant: true });
      const state = this.transferFrom(json.transfer ?? json);
      if (!state) {
        this.logger.error(`Lecture du transfert ${reference} : réponse inattendue ${JSON.stringify(json).slice(0, 500)}`);
        throw new BadGatewayException('Le service de paiement a renvoyé une réponse inattendue.');
      }
      return state;
    } catch (error) {
      if (error instanceof NotFoundException) return null;
      throw error;
    }
  }

  parseTransferWebhook(rawBody: Buffer): { reference: string } | null {
    let event: unknown;
    try {
      event = JSON.parse(rawBody.toString('utf-8'));
    } catch {
      return null;
    }
    const type = pickString(event, 'type', 'event') ?? '';
    if (!type.startsWith('transfer.')) return null;
    const root = isObject(event) && isObject(event.data) ? event.data : {};
    const data = isObject(root.transfer) ? root.transfer : root;
    const reference = pickString(data, 'reference', 'merchant_reference');
    return reference ? { reference } : null;
  }

  private transferFrom(data: unknown): TransferState | null {
    if (!isObject(data)) return null;
    const gatewayRef = pickString(data, 'id', 'reference');
    const reference = pickString(data, 'reference', 'merchant_reference');
    if (!gatewayRef || !reference) return null;
    const s = (pickString(data, 'status') ?? '').toLowerCase();
    // Seul « complete » vaut versement réussi ; « reversed » = argent revenu, donc échec.
    const status = s === 'complete' || s === 'completed' ? 'COMPLETE' : ['failed', 'reversed', 'canceled', 'cancelled', 'rejected'].includes(s) ? 'FAILED' : 'PENDING';
    const amount = Number(data.amount);
    return {
      status,
      gatewayRef,
      reference,
      failureReason: status === 'FAILED' ? (pickString(data, 'failure_reason', 'message', 'reason') ?? `Statut « ${s} »`) : undefined,
      amount: Number.isFinite(amount) ? amount : undefined,
    };
  }

  // ---------------------------------------------------------------------
  // Aides internes
  // ---------------------------------------------------------------------

  private keys() {
    return this.configService.get('payment.notchpay', { infer: true });
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown, options: { grant?: boolean } = {}): Promise<Json> {
    const { publicKey, apiUrl } = this.keys();
    const privateKey = process.env.NOTCHPAY_PRIVATE_KEY ?? '';
    if (options.grant && !privateKey) {
      this.logger.error('NOTCHPAY_PRIVATE_KEY est absente : aucun transfert possible.');
      throw new ServiceUnavailableException("Les versements ne sont pas encore configurés (clé privée Notch Pay absente).");
    }
    if (!publicKey) {
      this.logger.error('NOTCHPAY_PUBLIC_KEY est absente : aucun appel à Notch Pay possible.');
      throw new ServiceUnavailableException("Le paiement n'est pas encore disponible.");
    }

    let response: Response;
    try {
      response = await fetch(`${apiUrl || DEFAULT_API_URL}${path}`, {
        method,
        headers: {
          Authorization: publicKey,
          ...(options.grant ? { 'X-Grant': privateKey } : {}),
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
      if (options.grant && response.status === 422) {
        // Transfert refusé : on rend le motif de Notch Pay lisible par la finance.
        const details = isObject(json.errors)
          ? Object.entries(json.errors).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`).join(' ; ')
          : '';
        const reason = [pickString(json, 'message') ?? 'données refusées', details].filter(Boolean).join(' — ');
        throw new UnprocessableEntityException(`Notch Pay a refusé le transfert : ${reason}`.slice(0, 300));
      }
      if (response.status === 422) {
        // Données refusées par Notch Pay. Le cas du numéro de téléphone est traité par l'appelant.
        if (mentionsPhone(json)) throw new PhoneRejectedError();
        throw new UnprocessableEntityException(
          "Le service de paiement a refusé les informations de votre compte. Vérifiez votre profil (« Mes informations »), puis réessayez.",
        );
      }
      if (options.grant && (response.status === 401 || response.status === 403)) {
        throw new ServiceUnavailableException(
          "Notch Pay refuse l'accès aux transferts : vérifiez les clés (publique et privée) et que l'adresse IP du serveur est autorisée dans le tableau de bord Notch Pay.",
        );
      }
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

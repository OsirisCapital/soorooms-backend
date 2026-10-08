import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotchPayGateway } from './notchpay.gateway.js';

const HASH_KEY = 'hash_test_cle_de_signature';
const PUBLIC_KEY = 'pk_test_exemple';
const BOOKING_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

function makeGateway(keys: Partial<{ publicKey: string; privateKey: string; hashKey: string }> = {}) {
  const notchpay = { publicKey: PUBLIC_KEY, privateKey: 'sk_test', hashKey: HASH_KEY, ...keys };
  const config = { get: (key: string) => (key === 'payment.notchpay' ? notchpay : undefined) };
  return new NotchPayGateway(config as never);
}

const sign = (body: string, key = HASH_KEY) => createHmac('sha256', key).update(body).digest('hex');

describe('NotchPayGateway — signature des webhooks', () => {
  const body = JSON.stringify({ type: 'payment.complete', data: { reference: 'trx.abc' } });

  it('accepte une signature valide calculée sur le corps brut', () => {
    expect(makeGateway().verifyWebhookSignature(Buffer.from(body), sign(body))).toBe(true);
  });

  it('accepte le préfixe « sha256= » et les majuscules', () => {
    const gateway = makeGateway();
    expect(gateway.verifyWebhookSignature(Buffer.from(body), `sha256=${sign(body)}`)).toBe(true);
    expect(gateway.verifyWebhookSignature(Buffer.from(body), sign(body).toUpperCase())).toBe(true);
  });

  it('refuse un corps modifié après signature', () => {
    const tampered = body.replace('trx.abc', 'trx.zzz');
    expect(makeGateway().verifyWebhookSignature(Buffer.from(tampered), sign(body))).toBe(false);
  });

  it('refuse une signature faite avec une autre clé', () => {
    expect(makeGateway().verifyWebhookSignature(Buffer.from(body), sign(body, 'autre_cle'))).toBe(false);
  });

  it('refuse une signature absente, trop courte ou non hexadécimale', () => {
    const gateway = makeGateway();
    expect(gateway.verifyWebhookSignature(Buffer.from(body), undefined)).toBe(false);
    expect(gateway.verifyWebhookSignature(Buffer.from(body), 'abc123')).toBe(false);
    expect(gateway.verifyWebhookSignature(Buffer.from(body), 'z'.repeat(64))).toBe(false);
  });

  it('refuse tout quand la clé de hachage n’est pas configurée', () => {
    expect(makeGateway({ hashKey: '' }).verifyWebhookSignature(Buffer.from(body), sign(body))).toBe(false);
  });
});

describe('NotchPayGateway — lecture des webhooks', () => {
  const event = (type: string, data: Record<string, unknown>) => Buffer.from(JSON.stringify({ type, data }));

  it('normalise un paiement réussi (notre référence dans merchant_reference)', () => {
    const parsed = makeGateway().parseWebhookPayload(
      event('payment.complete', {
        reference: 'trx.NOTCH123',
        merchant_reference: `${BOOKING_ID}_lx3k9`,
        amount: 20000,
        status: 'complete',
        channel: 'cm.mtn',
      }),
    );
    expect(parsed).toEqual({
      gatewayRef: 'trx.NOTCH123',
      status: 'SUCCESS',
      amount: 20000,
      paymentMethod: 'MTN_MOMO',
      bookingReference: BOOKING_ID,
    });
  });

  it('retrouve notre référence quand elle est dans « reference »', () => {
    const parsed = makeGateway().parseWebhookPayload(
      event('payment.complete', { reference: `${BOOKING_ID}_lx3k9`, amount: 20000, channel: 'cm.orange' }),
    );
    expect(parsed?.bookingReference).toBe(BOOKING_ID);
    expect(parsed?.gatewayRef).toBe(`${BOOKING_ID}_lx3k9`);
    expect(parsed?.paymentMethod).toBe('ORANGE_MONEY');
  });

  it('lit aussi un payload où les données sont sous « transaction »', () => {
    const parsed = makeGateway().parseWebhookPayload(
      event('payment.failed', { transaction: { reference: `${BOOKING_ID}_a1`, amount: 5000, status: 'failed' } }),
    );
    expect(parsed?.status).toBe('FAILED');
    expect(parsed?.bookingReference).toBe(BOOKING_ID);
  });

  it.each([
    ['payment.failed', 'FAILED'],
    ['payment.canceled', 'FAILED'],
    ['payment.expired', 'FAILED'],
    ['payment.created', 'PENDING'],
  ])('traduit « %s » en %s', (type, expected) => {
    const parsed = makeGateway().parseWebhookPayload(event(type, { reference: `${BOOKING_ID}_a1`, amount: 1000 }));
    expect(parsed?.status).toBe(expected);
  });

  it('ne confirme jamais un paiement dont le statut interne est un échec', () => {
    const parsed = makeGateway().parseWebhookPayload(
      event('payment.complete', { reference: `${BOOKING_ID}_a1`, amount: 1000, status: 'failed' }),
    );
    expect(parsed?.status).toBe('FAILED');
  });

  it('ignore les événements qui ne sont pas des paiements', () => {
    expect(makeGateway().parseWebhookPayload(event('transfer.complete', { reference: 'trf.1' }))).toBeNull();
    expect(makeGateway().parseWebhookPayload(event('customer.created', { id: 'cus_1' }))).toBeNull();
  });

  it('rejette un paiement dont aucune référence ne ressemble à une réservation', () => {
    expect(() =>
      makeGateway().parseWebhookPayload(event('payment.complete', { reference: 'order_123', amount: 1000 })),
    ).toThrow(/Référence de paiement non reconnue/);
  });

  it('rejette un corps qui n’est pas du JSON', () => {
    expect(() => makeGateway().parseWebhookPayload(Buffer.from('pas du json'))).toThrow(/illisible/);
  });
});

describe('NotchPayGateway — appels à l’API', () => {
  const fetchMock = vi.fn();
  beforeEach(() => vi.stubGlobal('fetch', fetchMock));
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  const reply = (status: number, body: unknown) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

  const params = {
    amount: 20000.4,
    currency: 'XAF',
    reference: `${BOOKING_ID}_lx3k9`,
    description: 'Réservation — Chambre principale',
    customer: { name: 'Aline K.', phone: '+237694952656' },
    callbackUrl: `https://soorooms.vercel.app/profil/reservations/${BOOKING_ID}`,
  };

  it('crée un paiement avec la clé publique et renvoie le lien de paiement', async () => {
    fetchMock.mockResolvedValue(
      reply(201, {
        status: 'Accepted',
        code: 201,
        transaction: { reference: 'trx.NOTCH123' },
        authorization_url: 'https://pay.notchpay.co/trx.NOTCH123',
      }),
    );
    const result = await makeGateway().initiatePayment(params);

    expect(result).toEqual({ paymentUrl: 'https://pay.notchpay.co/trx.NOTCH123', gatewayRef: 'trx.NOTCH123' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.notchpay.co/payments');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(PUBLIC_KEY); // sans « Bearer », comme l'exige Notch Pay
    expect(JSON.parse(init.body)).toEqual({
      amount: 20000, // arrondi : pas de décimales en FCFA
      currency: 'XAF',
      reference: params.reference,
      description: params.description,
      callback: params.callbackUrl,
      customer: { name: 'Aline K.', phone: '+237694952656' },
    });
  });

  it('accepte une réponse où « transaction » est une simple chaîne', async () => {
    fetchMock.mockResolvedValue(reply(201, { transaction: 'trx.STR', authorization_url: 'https://pay.notchpay.co/x' }));
    expect((await makeGateway().initiatePayment(params)).gatewayRef).toBe('trx.STR');
  });

  it('n’appelle pas Notch Pay sans clé publique', async () => {
    await expect(makeGateway({ publicKey: '' }).initiatePayment(params)).rejects.toThrow(/pas encore disponible/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('transforme un refus de clé en message neutre pour l’utilisateur', async () => {
    fetchMock.mockResolvedValue(reply(401, { message: 'Invalid API key' }));
    const error = await makeGateway().initiatePayment(params).catch((e: Error) => e);
    expect((error as Error).message).toBe('Le paiement est momentanément indisponible.');
    expect((error as Error).message).not.toContain(PUBLIC_KEY);
  });

  it('signale proprement un Notch Pay injoignable', async () => {
    fetchMock.mockRejectedValue(new Error('fetch failed'));
    await expect(makeGateway().initiatePayment(params)).rejects.toThrow(/ne répond pas/);
  });

  it('refuse une réponse de création sans lien de paiement', async () => {
    fetchMock.mockResolvedValue(reply(201, { transaction: { reference: 'trx.X' } }));
    await expect(makeGateway().initiatePayment(params)).rejects.toThrow(/réponse inattendue/);
  });

  it('lit l’état d’un paiement (statut, montant, devise en majuscules)', async () => {
    fetchMock.mockResolvedValue(
      reply(202, { transaction: { reference: 'trx.NOTCH123', status: 'complete', amount: 20000, currency: 'xaf' } }),
    );
    const verified = await makeGateway().verifyPayment('trx.NOTCH123');
    expect(verified).toMatchObject({ status: 'SUCCESS', amount: 20000, currency: 'XAF' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.notchpay.co/payments/trx.NOTCH123');
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
  });

  it('rattache le paiement à une réservation quand notre référence est dans merchant_reference', async () => {
    fetchMock.mockResolvedValue(
      reply(202, {
        transaction: {
          reference: 'trx.NOTCH123',
          merchant_reference: `${BOOKING_ID}_lx3k9`,
          status: 'complete',
          amount: 20000,
          currency: 'XAF',
          channel: 'cm.orange',
        },
      }),
    );
    const verified = await makeGateway().verifyPayment('trx.NOTCH123');
    expect(verified).toMatchObject({
      gatewayRef: 'trx.NOTCH123',
      bookingReference: BOOKING_ID,
      paymentMethod: 'ORANGE_MONEY',
    });
    expect(verified.raw).toMatchObject({ reference: 'trx.NOTCH123' });
  });

  it('rattache aussi le paiement quand notre référence est dans « reference »', async () => {
    fetchMock.mockResolvedValue(
      reply(202, { transaction: { reference: `${BOOKING_ID}_a1`, status: 'pending', amount: 5000, currency: 'XAF' } }),
    );
    const verified = await makeGateway().verifyPayment(`${BOOKING_ID}_a1`);
    expect(verified).toMatchObject({ status: 'PENDING', bookingReference: BOOKING_ID, gatewayRef: `${BOOKING_ID}_a1` });
  });

  it('ne rattache AUCUNE réservation quand aucune référence ne ressemble à la nôtre', async () => {
    fetchMock.mockResolvedValue(
      reply(202, { transaction: { reference: 'trx.ABC', status: 'complete', amount: 5000, currency: 'XAF' } }),
    );
    expect((await makeGateway().verifyPayment('trx.ABC')).bookingReference).toBeUndefined();
  });

  it('encode la référence dans l’URL de lecture', async () => {
    fetchMock.mockResolvedValue(reply(202, { transaction: { status: 'pending', amount: 1, currency: 'XAF' } }));
    await makeGateway().verifyPayment('a/b?c');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.notchpay.co/payments/a%2Fb%3Fc');
  });

  it('signale un paiement introuvable', async () => {
    fetchMock.mockResolvedValue(reply(404, { message: 'Not found' }));
    await expect(makeGateway().verifyPayment('trx.nope')).rejects.toThrow(/introuvable/);
  });

  it('refuse de promettre un reversement tant qu’il n’est pas branché', async () => {
    await expect(makeGateway().releaseFunds({ amount: 18000, reference: BOOKING_ID })).rejects.toThrow(
      /pas encore disponible/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

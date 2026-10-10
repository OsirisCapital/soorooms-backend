import { NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotchPayGateway } from './notchpay.gateway.js';

const config = { get: () => ({ publicKey: 'pk_test', hashKey: 'hash', apiUrl: 'https://api.test' }) };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const PARAMS = { amount: 27000.4, currency: 'XAF', reference: 'po_p1_1', description: 'Versement', beneficiary: { name: 'Awa Ngono', phone: '+237670000000', channel: 'cm.mtn' } } as const;

describe('NotchPayGateway — versements', () => {
  const gateway = new NotchPayGateway(config as never);
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    process.env.NOTCHPAY_PRIVATE_KEY = 'sk_test';
  });
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    delete process.env.NOTCHPAY_PRIVATE_KEY;
  });

  it('crée le bénéficiaire puis envoie le transfert avec les deux clés, montant entier', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(201, { beneficiary: { id: 'ben_9', name: 'Awa Ngono' } }))
      .mockResolvedValueOnce(reply(201, { transfer: { id: 'trn_1', reference: 'po_p1_1', status: 'pending', amount: 27000 } }));
    const state = await gateway.sendTransfer({ ...PARAMS });
    const [url1, init1] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url1).toBe('https://api.test/beneficiaries');
    expect(JSON.parse(init1.body as string)).toMatchObject({ name: 'Awa Ngono', phone: '+237670000000', country: 'CM', currency: 'XAF', type: 'mobile_money', channel: 'cm.mtn', account_number: '+237670000000' });
    const [url2, init2] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url2).toBe('https://api.test/transfers');
    expect(init2.headers).toMatchObject({ Authorization: 'pk_test', 'X-Grant': 'sk_test' });
    expect(JSON.parse(init2.body as string)).toMatchObject({ amount: 27000, currency: 'XAF', channel: 'cm.mtn', reference: 'po_p1_1', beneficiary: 'ben_9' });
    expect(state).toMatchObject({ status: 'PENDING', gatewayRef: 'trn_1', reference: 'po_p1_1' });
  });

  it("si la création du bénéficiaire échoue, aucun transfert n'est tenté et l'échec est « sûr » (pas un 502)", async () => {
    fetchMock.mockResolvedValueOnce(reply(500, {}));
    await expect(gateway.sendTransfer({ ...PARAMS })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sans clé privée : refuse avant tout appel réseau', async () => {
    delete process.env.NOTCHPAY_PRIVATE_KEY;
    await expect(gateway.sendTransfer({ ...PARAMS })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('traduit les statuts de Notch Pay', async () => {
    for (const [raw, expected] of [['complete', 'COMPLETE'], ['failed', 'FAILED'], ['reversed', 'FAILED'], ['processing', 'PENDING'], ['sent', 'PENDING']] as const) {
      fetchMock.mockResolvedValueOnce(reply(200, { transfer: { id: 't', reference: 'r', status: raw } }));
      expect((await gateway.getTransfer('r'))?.status).toBe(expected);
    }
  });

  it('un 404 veut dire « jamais reçu » (null), pas une erreur', async () => {
    fetchMock.mockResolvedValue(reply(404, { message: 'not found' }));
    await expect(gateway.getTransfer('inconnue')).resolves.toBeNull();
  });

  it('un 422 est un refus clair avec le motif de Notch Pay', async () => {
    fetchMock.mockResolvedValueOnce(reply(201, { beneficiary: { id: 'ben_9' } })).mockResolvedValueOnce(reply(422, { message: 'Insufficient balance' }));
    await expect(gateway.sendTransfer({ ...PARAMS })).rejects.toThrow('Insufficient balance');
    fetchMock.mockResolvedValue(reply(422, { message: 'Invalid', errors: { beneficiary: ['Invalid beneficiary format.'] } }));
    await expect(gateway.sendTransfer({ ...PARAMS })).rejects.toThrow('beneficiary: Invalid beneficiary format.');
    fetchMock.mockResolvedValue(reply(422, { message: 'x' }));
    await expect(gateway.sendTransfer({ ...PARAMS })).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("un 403 (IP ou clés) donne un message utile à la finance", async () => {
    fetchMock.mockResolvedValue(reply(403, {}));
    await expect(gateway.sendTransfer({ ...PARAMS })).rejects.toThrow(/adresse IP/);
  });

  it('reconnaît les webhooks de transfert et ignore les autres', () => {
    const body = (o: unknown) => Buffer.from(JSON.stringify(o));
    expect(gateway.parseTransferWebhook(body({ type: 'transfer.complete', data: { reference: 'po_p1_1' } }))).toEqual({ reference: 'po_p1_1' });
    expect(gateway.parseTransferWebhook(body({ event: 'transfer.failed', data: { transfer: { reference: 'po_p1_2' } } }))).toEqual({ reference: 'po_p1_2' });
    expect(gateway.parseTransferWebhook(body({ type: 'payment.complete', data: { reference: 'x' } }))).toBeNull();
    expect(gateway.parseTransferWebhook(Buffer.from('pas du json'))).toBeNull();
  });

  it('NotFoundException reste interne à getTransfer', async () => {
    fetchMock.mockResolvedValue(reply(404, {}));
    await expect(gateway.sendTransfer({ ...PARAMS })).rejects.toBeInstanceOf(NotFoundException);
  });
});

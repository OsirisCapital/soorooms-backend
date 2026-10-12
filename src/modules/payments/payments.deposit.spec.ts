import { describe, expect, it, vi } from 'vitest';
import { PaymentsService } from './payments.service.js';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const CHECK_IN = new Date(Date.now() + 40 * 86_400_000);

function setup(status: string, amountPaid: number) {
  const tx = {
    transaction: { create: vi.fn(), update: vi.fn() },
    booking: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUnique: vi.fn().mockResolvedValue({ checkInDate: CHECK_IN }) },
  };
  const booking = {
    id: ID, travelerId: 'u1', status, totalPrice: 20000, checkInDate: CHECK_IN, depositPercent: 30,
    room: { name: 'Salle' }, traveler: { fullName: 'Aline', phone: '+237694952656', email: null },
  };
  const escrow = { id: 'e1', bookingId: ID, amountHeld: 20000, depositAmount: 6000 };
  const prisma = {
    transaction: { findUnique: vi.fn().mockResolvedValue(null) },
    escrowVault: { findUnique: vi.fn().mockResolvedValue(escrow), create: vi.fn() },
    booking: { findUnique: vi.fn().mockResolvedValue(booking) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const gateway = {
    verifyWebhookSignature: vi.fn().mockReturnValue(true),
    parseTransferWebhook: vi.fn().mockReturnValue(null),
    parseWebhookPayload: vi.fn().mockReturnValue({ gatewayRef: 'trx.1', status: 'SUCCESS', amount: amountPaid, paymentMethod: 'MTN_MOMO', bookingReference: ID }),
    verifyPayment: vi.fn().mockResolvedValue({ status: 'SUCCESS', amount: amountPaid, currency: 'XAF' }),
    initiatePayment: vi.fn().mockResolvedValue({ paymentUrl: 'https://pay', gatewayRef: 'trx.1' }),
  };
  const config = { get: (k: string) => ({ frontendUrl: 'https://s.app' })[k] };
  const service = new PaymentsService(prisma as never, config as never, gateway as never);
  return { service, tx, gateway };
}
const hook = (s: PaymentsService) => s.handleWebhook(Buffer.from('{}'), 'sig');

describe('paiement en deux temps', () => {
  it('l’acompte bloque la date (DEPOSIT_PAID) et fixe l’échéance du solde', async () => {
    const { service, tx } = setup('PENDING_PAYMENT', 6000);
    await hook(service);
    expect(tx.transaction.create).toHaveBeenCalledWith({ data: expect.objectContaining({ kind: 'DEPOSIT', amount: 6000 }) });
    const call = tx.booking.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: ID, status: 'PENDING_PAYMENT' });
    expect(call.data.status).toBe('DEPOSIT_PAID');
    expect(call.data.balanceDueAt).toBeInstanceOf(Date);
    expect(call.data.balanceDueAt.getTime()).toBeLessThan(CHECK_IN.getTime());
  });

  it('le solde confirme la réservation (CONFIRMED_ESCROW) depuis DEPOSIT_PAID uniquement', async () => {
    const { service, tx } = setup('DEPOSIT_PAID', 14000);
    await hook(service);
    expect(tx.transaction.create).toHaveBeenCalledWith({ data: expect.objectContaining({ kind: 'BALANCE', amount: 14000 }) });
    expect(tx.booking.updateMany).toHaveBeenCalledWith({ where: { id: ID, status: 'DEPOSIT_PAID' }, data: { status: 'CONFIRMED_ESCROW' } });
  });

  it('refuse le prix total payé à la place de l’acompte', async () => {
    const { service, tx } = setup('PENDING_PAYMENT', 20000);
    await expect(hook(service)).rejects.toThrow(/Montant du paiement différent/);
    expect(tx.transaction.create).not.toHaveBeenCalled();
  });

  it('refuse l’acompte présenté comme solde', async () => {
    const { service, tx } = setup('DEPOSIT_PAID', 6000);
    await expect(hook(service)).rejects.toThrow(/Montant du paiement différent/);
    expect(tx.booking.updateMany).not.toHaveBeenCalled();
  });

  it('initie l’acompte puis le solde avec la bonne somme', async () => {
    const a = setup('PENDING_PAYMENT', 0);
    await expect(a.service.initiate(ID, 'u1')).resolves.toMatchObject({ stage: 'DEPOSIT', amount: 6000 });
    expect(a.gateway.initiatePayment).toHaveBeenCalledWith(expect.objectContaining({ amount: 6000, description: expect.stringContaining('acompte') }));
    const b = setup('DEPOSIT_PAID', 0);
    await expect(b.service.initiate(ID, 'u1')).resolves.toMatchObject({ stage: 'BALANCE', amount: 14000 });
  });

  it('n’initie aucun paiement une fois tout payé', async () => {
    await expect(setup('CONFIRMED_ESCROW', 0).service.initiate(ID, 'u1')).rejects.toThrow(/pas en attente de paiement/);
  });
});

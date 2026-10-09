import { describe, expect, it, vi } from 'vitest';
import { PaymentsService } from './payments.service.js';

const BOOKING_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

type Overrides = {
  existingTx?: unknown;
  event?: unknown;
  verified?: unknown;
  signatureValid?: boolean;
  booking?: Record<string, unknown> | null;
};

/** Service branché sur de faux Prisma et fausse passerelle, pour observer ce qui est (ou n'est pas) écrit. */
function setup(overrides: Overrides = {}) {
  const tx = {
    transaction: { create: vi.fn(), update: vi.fn() },
    booking: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  const defaultBooking = {
    id: BOOKING_ID,
    travelerId: 'user-1',
    status: 'PENDING_PAYMENT',
    totalPrice: 20000,
    room: { name: 'Chambre principale' },
    traveler: { fullName: 'Aline K.', phone: '+237694952656', email: null },
  };
  const prisma = {
    transaction: { findUnique: vi.fn().mockResolvedValue(overrides.existingTx ?? null) },
    escrowVault: {
      findUnique: vi.fn().mockResolvedValue({ id: 'escrow-1', bookingId: BOOKING_ID, amountHeld: 20000 }),
      create: vi.fn().mockResolvedValue({ id: 'escrow-1' }),
    },
    booking: {
      findUnique: vi
        .fn()
        .mockResolvedValue(overrides.booking === undefined ? defaultBooking : overrides.booking),
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const gateway = {
    verifyWebhookSignature: vi.fn().mockReturnValue(overrides.signatureValid ?? true),
    parseWebhookPayload: vi.fn().mockReturnValue(
      
      overrides.event === undefined
        ? { gatewayRef: 'trx.1', status: 'SUCCESS', amount: 20000, paymentMethod: 'MTN_MOMO', bookingReference: BOOKING_ID }
        : overrides.event,
    ),
    parseTransferWebhook: vi.fn().mockReturnValue(null),
    verifyPayment: vi
      .fn()
      .mockResolvedValue(overrides.verified ?? { status: 'SUCCESS', amount: 20000, currency: 'XAF' }),
    initiatePayment: vi.fn().mockResolvedValue({ paymentUrl: 'https://pay.notchpay.co/trx.1', gatewayRef: 'trx.1' }),
    releaseFunds: vi.fn(),
  };
  const values: Record<string, unknown> = { frontendUrl: 'https://soorooms.vercel.app', 'payment.platformFeePercent': 10 };
  const config = { get: (key: string) => values[key] };
  const service = new PaymentsService(prisma as never, config as never, gateway as never);
  return { service, prisma, gateway, tx };
}

const webhook = (service: PaymentsService) => service.handleWebhook(Buffer.from('{}'), 'signature');

describe('PaymentsService.handleWebhook', () => {
  it('rejette une signature invalide sans rien lire ni écrire', async () => {
    const { service, gateway, prisma } = setup({ signatureValid: false });
    await expect(webhook(service)).rejects.toThrow(/Signature de webhook invalide/);
    expect(gateway.parseWebhookPayload).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('acquitte sans effet un événement qui n’est pas un paiement', async () => {
    const { service, prisma } = setup({ event: null });
    await expect(webhook(service)).resolves.toEqual({ ignored: true });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('confirme la réservation quand le webhook ET l’API disent « payé » pour le bon montant', async () => {
    const { service, tx, gateway } = setup();
    await expect(webhook(service)).resolves.toEqual({ processed: true });

    expect(gateway.verifyPayment).toHaveBeenCalledWith('trx.1');
    expect(tx.transaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        escrowId: 'escrow-1',
        paymentGatewayId: 'trx.1',
        amount: 20000,
        transactionStatus: 'SUCCESS',
      }),
    });
    // Uniquement depuis PENDING_PAYMENT : un webhook tardif ne ressuscite pas une réservation annulée.
    expect(tx.booking.updateMany).toHaveBeenCalledWith({
      where: { id: BOOKING_ID, status: 'PENDING_PAYMENT' },
      data: { status: 'CONFIRMED_ESCROW' },
    });
  });

  it('ne confirme PAS quand l’API répond que le paiement n’est pas encore réussi', async () => {
    const { service, prisma } = setup({ verified: { status: 'PENDING', amount: 20000, currency: 'XAF' } });
    await expect(webhook(service)).rejects.toThrow(/non confirmé/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('ne confirme PAS quand l’API contredit le montant annoncé par le webhook', async () => {
    // Le webhook prétend 20000 ; l'API, qui fait foi, n'a encaissé que 100.
    const { service, prisma } = setup({ verified: { status: 'SUCCESS', amount: 100, currency: 'XAF' } });
    await expect(webhook(service)).rejects.toThrow(/Montant du paiement différent/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('ne confirme PAS un paiement dans une autre devise', async () => {
    const { service, prisma } = setup({ verified: { status: 'SUCCESS', amount: 20000, currency: 'EUR' } });
    await expect(webhook(service)).rejects.toThrow(/Devise/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('ne confirme PAS quand la lecture directe de l’API échoue', async () => {
    const { service, gateway, prisma } = setup();
    gateway.verifyPayment.mockRejectedValue(new Error('Notch Pay injoignable'));
    await expect(webhook(service)).rejects.toThrow(/injoignable/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('ignore la répétition d’un paiement déjà confirmé, sans réinterroger l’API', async () => {
    const { service, gateway, prisma } = setup({ existingTx: { id: 'tx-1', transactionStatus: 'SUCCESS' } });
    await expect(webhook(service)).resolves.toEqual({ alreadyProcessed: true });
    expect(gateway.verifyPayment).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('enregistre un échec sans toucher à la réservation ni appeler l’API de vérification', async () => {
    const { service, tx, gateway } = setup({
      event: { gatewayRef: 'trx.2', status: 'FAILED', amount: Number.NaN, paymentMethod: 'MTN_MOMO', bookingReference: BOOKING_ID },
    });
    await expect(webhook(service)).resolves.toEqual({ processed: true });
    expect(gateway.verifyPayment).not.toHaveBeenCalled();
    expect(tx.booking.updateMany).not.toHaveBeenCalled();
    // Montant illisible dans l'événement d'échec : on garde celui du séquestre plutôt que NaN.
    expect(tx.transaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ transactionStatus: 'FAILED', amount: 20000 }),
    });
  });

  it('fait passer à SUCCESS un paiement d’abord enregistré en attente', async () => {
    const { service, tx } = setup({ existingTx: { id: 'tx-1', transactionStatus: 'PENDING' } });
    await expect(webhook(service)).resolves.toEqual({ processed: true });
    expect(tx.transaction.update).toHaveBeenCalledWith({
      where: { id: 'tx-1' },
      data: expect.objectContaining({ transactionStatus: 'SUCCESS', amount: 20000 }),
    });
    expect(tx.transaction.create).not.toHaveBeenCalled();
  });
});

describe('PaymentsService.initiate', () => {
  it('envoie à la passerelle une référence unique, le client et l’URL de retour', async () => {
    const { service, gateway } = setup();
    const result = await service.initiate(BOOKING_ID, 'user-1');

    expect(result).toMatchObject({ paymentUrl: 'https://pay.notchpay.co/trx.1', gatewayRef: 'trx.1' });
    const call = gateway.initiatePayment.mock.calls[0][0];
    expect(call.reference).toMatch(new RegExp(`^${BOOKING_ID}_[0-9a-z]+$`));
    expect(call).toMatchObject({
      amount: 20000,
      currency: 'XAF',
      customer: { name: 'Aline K.', phone: '+237694952656' },
      callbackUrl: `https://soorooms.vercel.app/profil/reservations/${BOOKING_ID}`,
    });
  });

  it('génère une référence différente à chaque tentative', async () => {
    const { service, gateway } = setup();
    await service.initiate(BOOKING_ID, 'user-1');
    await new Promise((resolve) => setTimeout(resolve, 3));
    await service.initiate(BOOKING_ID, 'user-1');
    const [first, second] = gateway.initiatePayment.mock.calls.map((c) => c[0].reference);
    expect(first).not.toBe(second);
  });

  it('ne transmet jamais le faux numéro « google:… » des comptes Google, mais leur e-mail', async () => {
    const { service, gateway } = setup({
      booking: {
        id: BOOKING_ID, travelerId: 'user-1', status: 'PENDING_PAYMENT', totalPrice: 20000,
        room: { name: 'Chambre' },
        traveler: { fullName: 'Aline K.', phone: 'google:1234567890', email: 'aline@example.com' },
      },
    });
    await service.initiate(BOOKING_ID, 'user-1');
    const { customer } = gateway.initiatePayment.mock.calls[0][0];
    expect(customer).toEqual({ name: 'Aline K.', phone: undefined, email: 'aline@example.com' });
  });

  it('refuse de payer sans aucun moyen de contacter le client', async () => {
    const { service, gateway } = setup({
      booking: {
        id: BOOKING_ID, travelerId: 'user-1', status: 'PENDING_PAYMENT', totalPrice: 20000,
        room: { name: 'Chambre' },
        traveler: { fullName: 'Aline K.', phone: 'google:1234567890', email: null },
      },
    });
    await expect(service.initiate(BOOKING_ID, 'user-1')).rejects.toThrow(/numéro de téléphone ou une adresse e-mail/);
    expect(gateway.initiatePayment).not.toHaveBeenCalled();
  });

  it('refuse à quelqu’un d’autre que le voyageur d’initier le paiement', async () => {
    const { service, gateway } = setup();
    await expect(service.initiate(BOOKING_ID, 'intrus')).rejects.toThrow(/Seul le voyageur/);
    expect(gateway.initiatePayment).not.toHaveBeenCalled();
  });

  it('refuse une réservation qui n’est pas en attente de paiement', async () => {
    const { service } = setup({
      booking: {
        id: BOOKING_ID, travelerId: 'user-1', status: 'CONFIRMED_ESCROW', totalPrice: 20000,
        room: { name: 'Chambre' }, traveler: { fullName: 'A', phone: '+237694952656', email: null },
      },
    });
    await expect(service.initiate(BOOKING_ID, 'user-1')).rejects.toThrow(/pas en attente de paiement/);
  });
});


describe('PaymentsService.verifyReturn', () => {
  const paid = (over: object = {}) => ({
    status: 'SUCCESS',
    amount: 20000,
    currency: 'XAF',
    gatewayRef: 'trx.1',
    bookingReference: BOOKING_ID,
    paymentMethod: 'MTN_MOMO',
    raw: { reference: 'trx.1' },
    ...over,
  });

  const pendingBooking = { id: BOOKING_ID, travelerId: 'user-1', status: 'PENDING_PAYMENT', totalPrice: 20000 };

  /** Configure aussi la relecture finale de la réservation, qui doit refléter le passage en CONFIRMED_ESCROW. */
  function ready(over: Parameters<typeof setup>[0] = {}) {
    const ctx = setup({ booking: pendingBooking, verified: paid(), ...over });
    ctx.prisma.booking.findUnique
      .mockResolvedValueOnce(pendingBooking)
      .mockResolvedValue({ ...pendingBooking, status: 'CONFIRMED_ESCROW' });
    return ctx;
  }

  it('confirme la réservation quand l’agrégateur dit « payé » pour CETTE réservation, au bon montant', async () => {
    const { service, tx, gateway } = ready();
    await expect(service.verifyReturn(BOOKING_ID, 'user-1', 'trx.1')).resolves.toEqual({
      confirmed: true,
      paymentStatus: 'SUCCESS',
      bookingStatus: 'CONFIRMED_ESCROW',
    });
    expect(gateway.verifyPayment).toHaveBeenCalledWith('trx.1');
    expect(tx.transaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        escrowId: 'escrow-1',
        paymentGatewayId: 'trx.1', // la référence CANONIQUE de l'agrégateur, la même que celle du webhook
        amount: 20000,
        transactionStatus: 'SUCCESS',
        paymentMethod: 'MTN_MOMO',
      }),
    });
    expect(tx.booking.updateMany).toHaveBeenCalledWith({
      where: { id: BOOKING_ID, status: 'PENDING_PAYMENT' },
      data: { status: 'CONFIRMED_ESCROW' },
    });
  });

  it('SÉCURITÉ : refuse un paiement qui se rattache à UNE AUTRE réservation', async () => {
    // Le voyageur a payé une petite réservation et présente cette référence pour en confirmer une plus chère.
    const { service, prisma } = ready({ verified: paid({ bookingReference: '11111111-2222-4333-8444-555555555555' }) });
    await expect(service.verifyReturn(BOOKING_ID, 'user-1', 'trx.1')).rejects.toThrow(/ne correspond pas à cette réservation/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('SÉCURITÉ : refuse un paiement dont aucune réservation n’est reconnaissable', async () => {
    const { service, prisma } = ready({ verified: paid({ bookingReference: undefined }) });
    await expect(service.verifyReturn(BOOKING_ID, 'user-1', 'trx.1')).rejects.toThrow(/ne correspond pas à cette réservation/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('SÉCURITÉ : refuse à quelqu’un d’autre que le voyageur', async () => {
    const { service, gateway } = ready();
    await expect(service.verifyReturn(BOOKING_ID, 'intrus', 'trx.1')).rejects.toThrow(/Seul le voyageur/);
    expect(gateway.verifyPayment).not.toHaveBeenCalled();
  });

  it('ne confirme PAS un montant différent de celui attendu', async () => {
    const { service, prisma } = ready({ verified: paid({ amount: 100 }) });
    await expect(service.verifyReturn(BOOKING_ID, 'user-1', 'trx.1')).rejects.toThrow(/Montant du paiement différent/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('ne confirme PAS un paiement dans une autre devise', async () => {
    const { service, prisma } = ready({ verified: paid({ currency: 'EUR' }) });
    await expect(service.verifyReturn(BOOKING_ID, 'user-1', 'trx.1')).rejects.toThrow(/Devise/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('paiement encore en cours : ne conclut pas, n’écrit rien, laisse le frontend réessayer', async () => {
    const { service, prisma } = ready({ verified: paid({ status: 'PENDING' }) });
    await expect(service.verifyReturn(BOOKING_ID, 'user-1', 'trx.1')).resolves.toEqual({
      confirmed: false,
      paymentStatus: 'PENDING',
      bookingStatus: 'PENDING_PAYMENT',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('paiement échoué : l’enregistre, ne touche pas à la réservation', async () => {
    const { service, tx } = ready({ verified: paid({ status: 'FAILED' }) });
    await expect(service.verifyReturn(BOOKING_ID, 'user-1', 'trx.1')).resolves.toEqual({
      confirmed: false,
      paymentStatus: 'FAILED',
      bookingStatus: 'PENDING_PAYMENT',
    });
    expect(tx.transaction.create).toHaveBeenCalledWith({ data: expect.objectContaining({ transactionStatus: 'FAILED' }) });
    expect(tx.booking.updateMany).not.toHaveBeenCalled();
  });

  it('ne rétrograde jamais un paiement déjà confirmé par le webhook', async () => {
    const { service, prisma } = ready({
      verified: paid({ status: 'FAILED' }),
      existingTx: { id: 'tx-1', transactionStatus: 'SUCCESS' },
    });
    await service.verifyReturn(BOOKING_ID, 'user-1', 'trx.1');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('réservation déjà confirmée (le webhook est arrivé avant) : renvoie le résultat sans interroger l’agrégateur', async () => {
    const { service, gateway } = setup({ booking: { ...pendingBooking, status: 'CONFIRMED_ESCROW' } });
    await expect(service.verifyReturn(BOOKING_ID, 'user-1', 'trx.1')).resolves.toMatchObject({
      confirmed: true,
      bookingStatus: 'CONFIRMED_ESCROW',
    });
    expect(gateway.verifyPayment).not.toHaveBeenCalled();
  });

  it('refuse une réservation annulée ou encore en négociation', async () => {
    for (const status of ['CANCELLED', 'NEGOTIATING']) {
      const { service } = setup({ booking: { ...pendingBooking, status } });
      await expect(service.verifyReturn(BOOKING_ID, 'user-1', 'trx.1')).rejects.toThrow(/pas en attente de paiement/);
    }
  });

  it('réessayer après un succès déjà enregistré est sans effet néfaste (idempotent)', async () => {
    const { service, tx } = ready({ existingTx: { id: 'tx-1', transactionStatus: 'SUCCESS' } });
    await expect(service.verifyReturn(BOOKING_ID, 'user-1', 'trx.1')).resolves.toMatchObject({ confirmed: true });
    expect(tx.transaction.create).not.toHaveBeenCalled();
    expect(tx.transaction.update).toHaveBeenCalledTimes(1); // mise à jour, jamais une 2e transaction
  });

  it('laisse remonter une panne de l’agrégateur sans rien écrire', async () => {
    const { service, gateway, prisma } = ready();
    gateway.verifyPayment.mockRejectedValue(new Error('Notch Pay injoignable'));
    await expect(service.verifyReturn(BOOKING_ID, 'user-1', 'trx.1')).rejects.toThrow(/injoignable/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

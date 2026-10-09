import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import { PaymentsService } from './payments.service.js';

const BOOKING = '0f8fad5b-d9cb-469f-a165-70867728950e';

function make(opts: { moved?: number; existing?: { id: string; transactionStatus: string } | null; verifiedStatus?: 'SUCCESS' | 'FAILED' } = {}) {
  const tx = {
    transaction: { create: vi.fn(), update: vi.fn() },
    booking: { updateMany: vi.fn().mockResolvedValue({ count: opts.moved ?? 1 }) },
  };
  const prisma = {
    booking: {
      findUnique: vi.fn().mockImplementation(async (args: { select?: unknown }) =>
        args?.select
          ? { id: BOOKING, travelerId: 'traveler-1', room: { property: { title: 'Villa Kribi', collaborators: [{ userId: 'host-a' }] } } }
          : { id: BOOKING, travelerId: 'traveler-1', status: 'PENDING_PAYMENT' },
      ),
    },
    escrowVault: { findUnique: vi.fn().mockResolvedValue({ id: 'e1', bookingId: BOOKING, amountHeld: 20000 }) },
    transaction: { findUnique: vi.fn().mockResolvedValue(opts.existing ?? null) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const gateway = {
    verifyPayment: vi.fn().mockResolvedValue({
      status: opts.verifiedStatus ?? 'SUCCESS',
      currency: 'XAF',
      amount: 20000,
      gatewayRef: 'trx.1',
      bookingReference: BOOKING,
      paymentMethod: 'MTN_MOMO',
      raw: {},
    }),
  };
  const notifications = { notify: vi.fn().mockResolvedValue(true), notifyMany: vi.fn().mockResolvedValue(undefined) };
  const build = (withNotifications = true) =>
    new PaymentsService(prisma as unknown as PrismaService, {} as never, gateway as never, (withNotifications ? notifications : undefined) as unknown as NotificationsService);
  return { build, prisma, tx, gateway, notifications };
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

describe('PaymentsService — notifications de paiement', () => {
  it('un paiement confirmé prévient le voyageur et les hôtes, avec le montant vérifié', async () => {
    const { build, notifications } = make();
    const result = await build().verifyReturn(BOOKING, 'traveler-1', 'trx.1');
    expect(result.confirmed).toBe(true);
    expect(notifications.notify).toHaveBeenCalledWith('traveler-1', 'PAYMENT_CONFIRMED', { bookingId: BOOKING, audience: 'traveler', amount: 20000, propertyTitle: 'Villa Kribi' });
    expect(notifications.notifyMany).toHaveBeenCalledWith(['host-a'], 'PAYMENT_CONFIRMED', { bookingId: BOOKING, audience: 'host', amount: 20000, propertyTitle: 'Villa Kribi' });
  });

  it("ne notifie PAS si la réservation n'a pas avancé (paiement déjà pris en compte par un autre appel)", async () => {
    const { build, notifications } = make({ moved: 0 });
    await build().verifyReturn(BOOKING, 'traveler-1', 'trx.1');
    expect(notifications.notify).not.toHaveBeenCalled();
    expect(notifications.notifyMany).not.toHaveBeenCalled();
  });

  it("un échec de paiement prévient le voyageur une seule fois (pas à chaque vérification)", async () => {
    const first = make({ verifiedStatus: 'FAILED' });
    await first.build().verifyReturn(BOOKING, 'traveler-1', 'trx.1');
    expect(first.notifications.notify).toHaveBeenCalledWith('traveler-1', 'PAYMENT_FAILED', { bookingId: BOOKING, propertyTitle: 'Villa Kribi' });

    const repeat = make({ verifiedStatus: 'FAILED', existing: { id: 't1', transactionStatus: 'FAILED' } });
    await repeat.build().verifyReturn(BOOKING, 'traveler-1', 'trx.1');
    expect(repeat.notifications.notify).not.toHaveBeenCalled();
  });

  it("une alerte qui échoue ne fait jamais échouer le paiement", async () => {
    const { build, notifications } = make();
    notifications.notify.mockRejectedValue(new Error('boom'));
    await expect(build().verifyReturn(BOOKING, 'traveler-1', 'trx.1')).resolves.toMatchObject({ confirmed: true });
  });

  it("fonctionne sans service de notifications (ancien montage)", async () => {
    const { build } = make();
    await expect(build(false).verifyReturn(BOOKING, 'traveler-1', 'trx.1')).resolves.toMatchObject({ confirmed: true });
  });
});

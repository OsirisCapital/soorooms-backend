import { BadGatewayException, ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { RefundsService } from './refunds.service.js';

const REFUND = {
  id: 'r1', status: 'TO_SEND', attempts: 0, amount: 50000, travelerId: 't1', reference: null,
  beneficiaryChannel: 'cm.mtn', beneficiaryPhone: '+237670000000', beneficiaryName: 'Awa Ngono',
  escrow: { bookingId: 'b1', booking: { room: { property: { title: 'Villa' } } } },
};

function make(over: { refund?: object | null; claimCount?: number } = {}) {
  const tx = {
    refund: {
      updateMany: vi.fn().mockResolvedValue({ count: over.claimCount ?? 1 }),
      findUnique: vi.fn().mockResolvedValue({ escrowId: 'e1', amount: 50000, travelerId: 't1', escrow: REFUND.escrow }),
    },
    auditLog: { create: vi.fn() },
    escrowVault: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  const prisma = {
    refund: { findUnique: vi.fn().mockResolvedValue(over.refund === undefined ? REFUND : over.refund), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const gateway = { sendTransfer: vi.fn(), getTransfer: vi.fn() };
  const notifications = { notify: vi.fn(), notifyStaff: vi.fn() };
  const service = new RefundsService(prisma as never, gateway as never, notifications as never);
  vi.spyOn(service, 'list').mockResolvedValue([]);
  return { service, prisma, tx, gateway, notifications };
}

describe('RefundsService.send', () => {
  it('envoie au numéro du voyageur avec une référence rf_…, puis solde le remboursement', async () => {
    const c = make();
    c.gateway.sendTransfer.mockResolvedValue({ status: 'COMPLETE', gatewayRef: 'g1', reference: 'rf_r1_1' });
    await c.service.send('r1', 'fin');
    expect(c.gateway.sendTransfer).toHaveBeenCalledWith(expect.objectContaining({ amount: 50000, reference: 'rf_r1_1', beneficiary: { name: 'Awa Ngono', phone: '+237670000000', channel: 'cm.mtn' } }));
    expect(c.tx.escrowVault.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'REFUNDED_TO_TRAVELER' } }));
    expect(c.notifications.notify).toHaveBeenCalledWith('t1', 'REFUND_SENT', expect.objectContaining({ amount: 50000 }));
  });

  it('refuse sans numéro, sans rien réserver ni envoyer', async () => {
    const c = make({ refund: { ...REFUND, beneficiaryPhone: null } });
    await expect(c.service.send('r1', 'fin')).rejects.toBeInstanceOf(ConflictException);
    expect(c.prisma.$transaction).not.toHaveBeenCalled();
    expect(c.gateway.sendTransfer).not.toHaveBeenCalled();
  });

  it('refuse un remboursement déjà payé ou en cours', async () => {
    for (const status of ['PAID', 'SENDING', 'PROCESSING']) {
      const c = make({ refund: { ...REFUND, status } });
      await expect(c.service.send('r1', 'fin')).rejects.toBeInstanceOf(ConflictException);
      expect(c.gateway.sendTransfer).not.toHaveBeenCalled();
    }
  });

  it('deux clics simultanés : un seul envoi', async () => {
    const c = make({ claimCount: 0 });
    await expect(c.service.send('r1', 'fin')).rejects.toBeInstanceOf(ConflictException);
    expect(c.gateway.sendTransfer).not.toHaveBeenCalled();
  });

  it('refus clair de Notch Pay : échec, réessai permis, finance prévenue', async () => {
    const c = make();
    c.prisma.refund.findUnique.mockResolvedValueOnce(REFUND).mockResolvedValue({ amount: 50000, escrow: REFUND.escrow });
    c.gateway.sendTransfer.mockRejectedValue(new UnprocessableEntityException('numéro invalide'));
    await c.service.send('r1', 'fin');
    expect(c.prisma.refund.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }));
    expect(c.notifications.notifyStaff).toHaveBeenCalledWith('payouts.manage', 'REFUND_FAILED_STAFF', expect.anything());
  });

  it('réponse inconnue (réseau) : reste en cours, jamais marqué échec', async () => {
    const c = make();
    c.gateway.sendTransfer.mockRejectedValue(new BadGatewayException('injoignable'));
    await c.service.send('r1', 'fin');
    const statuses = c.prisma.refund.updateMany.mock.calls.map(([a]) => (a as { data: { status?: string } }).data.status);
    expect(statuses).not.toContain('FAILED');
  });
});

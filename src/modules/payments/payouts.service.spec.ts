import { BadGatewayException, BadRequestException, ConflictException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isDefiniteRejection, PayoutsService } from './payouts.service.js';

const PAYOUT = {
  id: 'p1',
  status: 'TO_SEND',
  attempts: 0,
  amount: 27000,
  hostUserId: 'h1',
  reference: null,
  escrowId: 'e1',
  escrow: { bookingId: 'b1', booking: { room: { property: { title: 'Villa Kribi' } } } },
};
const PROFILE = { payoutChannel: 'cm.mtn', payoutPhone: '+237670000000', payoutAccountName: 'Awa Ngono', payoutUpdatedAt: new Date('2026-01-01') };

function make(over: { payout?: object | null; profile?: object | null; claimCount?: number } = {}) {
  const tx = {
    payout: { updateMany: vi.fn().mockResolvedValue({ count: over.claimCount ?? 1 }), findUnique: vi.fn().mockResolvedValue({ escrowId: 'e1', amount: 27000, hostUserId: 'h1', escrow: PAYOUT.escrow }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    escrowVault: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  const prisma = {
    payout: { findUnique: vi.fn().mockResolvedValue(over.payout === undefined ? PAYOUT : over.payout), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    hostProfile: { findUnique: vi.fn().mockResolvedValue(over.profile === undefined ? PROFILE : over.profile) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const gateway = { sendTransfer: vi.fn(), getTransfer: vi.fn() };
  const notifications = { notify: vi.fn().mockResolvedValue(undefined), notifyStaff: vi.fn().mockResolvedValue(undefined) };
  const service = new PayoutsService(prisma as never, gateway as never, notifications as never);
  vi.spyOn(service, 'list').mockResolvedValue([]);
  return { service, prisma, tx, gateway, notifications };
}

const failedUpdates = (prisma: ReturnType<typeof make>['prisma']) =>
  prisma.payout.updateMany.mock.calls.filter(([arg]) => (arg as { data: { status?: string } }).data.status === 'FAILED');

describe('PayoutsService.send', () => {
  let ctx: ReturnType<typeof make>;
  beforeEach(() => {
    ctx = make();
  });

  it("refuse tant que l'hôte n'a pas renseigné son numéro, sans rien réserver ni envoyer", async () => {
    const c = make({ profile: { ...PROFILE, payoutPhone: null } });
    await expect(c.service.send('p1', 'fin')).rejects.toBeInstanceOf(BadRequestException);
    expect(c.prisma.$transaction).not.toHaveBeenCalled();
    expect(c.gateway.sendTransfer).not.toHaveBeenCalled();
  });

  it('refuse un versement déjà payé ou déjà en cours', async () => {
    for (const status of ['PAID', 'SENDING', 'PROCESSING']) {
      const c = make({ payout: { ...PAYOUT, status } });
      await expect(c.service.send('p1', 'fin')).rejects.toBeInstanceOf(ConflictException);
      expect(c.gateway.sendTransfer).not.toHaveBeenCalled();
    }
  });

  it("si quelqu'un d'autre a pris le versement entre-temps : aucun envoi", async () => {
    const c = make({ claimCount: 0 });
    await expect(c.service.send('p1', 'fin')).rejects.toBeInstanceOf(ConflictException);
    expect(c.gateway.sendTransfer).not.toHaveBeenCalled();
    expect(c.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("réserve le versement et écrit l'audit dans la même transaction, puis envoie avec une référence unique", async () => {
    ctx.gateway.sendTransfer.mockResolvedValue({ status: 'PENDING', gatewayRef: 'trn_1', reference: 'po_p1_1' });
    await ctx.service.send('p1', 'fin');
    expect(ctx.tx.payout.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'p1', attempts: 0 }),
        data: expect.objectContaining({ status: 'SENDING', attempts: 1, reference: 'po_p1_1', beneficiaryPhone: '+237670000000', sentById: 'fin' }),
      }),
    );
    expect(ctx.tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ actorId: 'fin', action: 'payout.send', targetId: 'p1' }) });
    expect(ctx.gateway.sendTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 27000, currency: 'XAF', reference: 'po_p1_1', beneficiary: { name: 'Awa Ngono', phone: '+237670000000', channel: 'cm.mtn' } }),
    );
    // Notch Pay a accepté : le versement passe à PROCESSING
    expect(ctx.prisma.payout.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'PROCESSING', gatewayRef: 'trn_1' }) }));
  });

  it('transfert terminé : versement payé, séquestre libéré, hôte prévenu', async () => {
    ctx.gateway.sendTransfer.mockResolvedValue({ status: 'COMPLETE', gatewayRef: 'trn_1', reference: 'po_p1_1' });
    await ctx.service.send('p1', 'fin');
    expect(ctx.tx.payout.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'PAID' }) }));
    expect(ctx.tx.escrowVault.updateMany).toHaveBeenCalledWith({ where: { id: 'e1', status: 'HELD_IN_ESCROW' }, data: { status: 'RELEASED_TO_HOST' } });
    expect(ctx.notifications.notify).toHaveBeenCalledWith('h1', 'PAYOUT_RELEASED', { bookingId: 'b1', amount: 27000, propertyTitle: 'Villa Kribi' });
  });

  it("refus clair de Notch Pay (422) : échec, réessai permis, la finance est prévenue", async () => {
    ctx.gateway.sendTransfer.mockRejectedValue(new UnprocessableEntityException('Notch Pay a refusé le transfert : numéro invalide'));
    await ctx.service.send('p1', 'fin');
    expect(failedUpdates(ctx.prisma)).toHaveLength(1);
    expect(ctx.notifications.notifyStaff).toHaveBeenCalledWith('payouts.manage', 'PAYOUT_FAILED_STAFF', expect.anything());
  });

  it('clés ou IP refusées (503) : échec sûr, rien n’est parti', async () => {
    ctx.gateway.sendTransfer.mockRejectedValue(new ServiceUnavailableException('IP non autorisée'));
    await ctx.service.send('p1', 'fin');
    expect(failedUpdates(ctx.prisma)).toHaveLength(1);
  });

  it("réseau coupé (502) : on NE sait PAS si l'ordre est parti → reste SENDING, jamais FAILED", async () => {
    ctx.gateway.sendTransfer.mockRejectedValue(new BadGatewayException('ne répond pas'));
    await ctx.service.send('p1', 'fin');
    expect(failedUpdates(ctx.prisma)).toHaveLength(0);
    expect(ctx.prisma.payout.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'p1', status: 'SENDING' }, data: { failureReason: expect.stringContaining('Vérifier') } }),
    );
  });

  it('un nouvel essai après échec utilise une nouvelle référence', async () => {
    const c = make({ payout: { ...PAYOUT, status: 'FAILED', attempts: 1, reference: 'po_p1_1' } });
    c.gateway.sendTransfer.mockResolvedValue({ status: 'PENDING', gatewayRef: 'trn_2', reference: 'po_p1_2' });
    await c.service.send('p1', 'fin');
    expect(c.gateway.sendTransfer).toHaveBeenCalledWith(expect.objectContaining({ reference: 'po_p1_2' }));
  });
});

describe('PayoutsService.markPaidManually', () => {
  it("marque payé, libère le séquestre, écrit l'audit avec la preuve et prévient l'hôte", async () => {
    const c = make();
    await c.service.markPaidManually('p1', 'fin', ' OM-12345 ');
    expect(c.tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'payout.manual_paid', meta: expect.objectContaining({ proof: 'OM-12345' }) }) }));
    expect(c.tx.escrowVault.updateMany).toHaveBeenCalled();
    expect(c.notifications.notify).toHaveBeenCalledWith('h1', 'PAYOUT_RELEASED', expect.objectContaining({ bookingId: 'b1' }));
    expect(c.gateway.sendTransfer).not.toHaveBeenCalled();
  });

  it('refuse si un envoi Notch Pay est en vol ou déjà payé', async () => {
    for (const status of ['SENDING', 'PROCESSING', 'PAID']) {
      const c = make({ payout: { ...PAYOUT, status } });
      await expect(c.service.markPaidManually('p1', 'fin', 'OM-1')).rejects.toBeInstanceOf(ConflictException);
      expect(c.tx.escrowVault.updateMany).not.toHaveBeenCalled();
    }
  });
});

describe('PayoutsService.check', () => {
  it("Notch Pay ne connaît pas la référence d'un envoi jamais abouti : échec sûr", async () => {
    const c = make({ payout: { ...PAYOUT, status: 'SENDING', attempts: 1, reference: 'po_p1_1' } });
    c.gateway.getTransfer.mockResolvedValue(null);
    await c.service.check('p1', 'fin');
    expect(failedUpdates(c.prisma)).toHaveLength(1);
    expect(c.prisma.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'payout.check' }) });
  });

  it("un transfert déjà en cours chez Notch Pay mais introuvable : on ne permet pas de réessayer", async () => {
    const c = make({ payout: { ...PAYOUT, status: 'PROCESSING', attempts: 1, reference: 'po_p1_1' } });
    c.gateway.getTransfer.mockResolvedValue(null);
    await expect(c.service.check('p1', 'fin')).rejects.toBeInstanceOf(ConflictException);
    expect(failedUpdates(c.prisma)).toHaveLength(0);
  });

  it('refuse de vérifier un versement qui n’a rien d’en cours', async () => {
    const c = make();
    await expect(c.service.check('p1', 'fin')).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('PayoutsService.applyTransferEvent', () => {
  it('ignore une référence inconnue', async () => {
    const c = make({ payout: null });
    await expect(c.service.applyTransferEvent('inconnue')).resolves.toEqual({ ignored: true });
    expect(c.gateway.getTransfer).not.toHaveBeenCalled();
  });

  it("ne croit que la relecture chez l'agrégateur", async () => {
    const c = make({ payout: { ...PAYOUT, status: 'PROCESSING', reference: 'po_p1_1' } });
    c.gateway.getTransfer.mockResolvedValue(null);
    await expect(c.service.applyTransferEvent('po_p1_1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('transfert confirmé : versement payé', async () => {
    const c = make({ payout: { ...PAYOUT, status: 'PROCESSING', reference: 'po_p1_1' } });
    c.gateway.getTransfer.mockResolvedValue({ status: 'COMPLETE', gatewayRef: 'trn_1', reference: 'po_p1_1' });
    await expect(c.service.applyTransferEvent('po_p1_1')).resolves.toEqual({ processed: true });
    expect(c.tx.payout.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'PAID' }) }));
  });
});

describe('PayoutsService.setDetails', () => {
  it('enregistre un numéro normalisé', async () => {
    const c = make();
    const upsert = vi.fn().mockResolvedValue({});
    (c.prisma.hostProfile as unknown as { upsert: typeof upsert }).upsert = upsert;
    await c.service.setDetails('h1', { channel: 'cm.orange', phone: '6 55 12 34 56', accountName: '  Awa   Ngono ' });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ payoutChannel: 'cm.orange', payoutPhone: '+237655123456', payoutAccountName: 'Awa Ngono' }) }),
    );
  });

  it('refuse un numéro qui n’est pas un mobile camerounais', async () => {
    const c = make();
    await expect(c.service.setDetails('h1', { channel: 'cm.mtn', phone: '12345', accountName: 'Awa' })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('isDefiniteRejection', () => {
  it('seul un 502 (réponse inconnue) n’est pas un refus clair', () => {
    expect(isDefiniteRejection(new UnprocessableEntityException())).toBe(true);
    expect(isDefiniteRejection(new ServiceUnavailableException())).toBe(true);
    expect(isDefiniteRejection(new BadGatewayException())).toBe(false);
    expect(isDefiniteRejection(new Error('boom'))).toBe(false);
  });
});

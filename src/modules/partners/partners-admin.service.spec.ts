import { BadGatewayException, BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { PartnersAdminService } from './partners-admin.service.js';

const PAYOUT = { id: 'po1', status: 'REQUESTED', attempts: 0, net: 12000, channel: 'cm.mtn', phone: '+237670000000', accountName: 'Awa Ngono', reference: null, partner: { userId: 'pu1', status: 'ACTIVE', user: { fullName: 'Awa Ngono', kycStatus: 'APPROVED' } } };

function make(payout: object | null = PAYOUT, claimCount = 1) {
  const tx = {
    partnerPayout: { updateMany: vi.fn().mockResolvedValue({ count: claimCount }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    partnerPayout: { findUnique: vi.fn().mockResolvedValue(payout), updateMany: vi.fn().mockResolvedValue({ count: 1 }), findMany: vi.fn().mockResolvedValue([]) },
    partnerProfile: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUnique: vi.fn() },
    partnerConfig: { update: vi.fn().mockResolvedValue({}) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const gateway = { sendTransfer: vi.fn(), getTransfer: vi.fn() };
  const partners = { getConfig: vi.fn().mockResolvedValue({}), balanceOf: vi.fn() };
  const notifications = { notify: vi.fn().mockResolvedValue(undefined) };
  const service = new PartnersAdminService(prisma as never, partners as never, gateway as never, notifications as never);
  vi.spyOn(service, 'listPayouts').mockResolvedValue([]);
  return { service, prisma, tx, gateway, notifications };
}

describe('PartnersAdminService.send', () => {
  it('réserve le retrait puis envoie le NET par Mobile Money', async () => {
    const c = make();
    c.gateway.sendTransfer.mockResolvedValue({ status: 'COMPLETE', gatewayRef: 'g1', reference: 'pp_po1_1' });
    await c.service.send('po1', 'fin');
    expect(c.tx.partnerPayout.updateMany.mock.calls[0]![0].data).toMatchObject({ status: 'SENDING', attempts: 1, reference: 'pp_po1_1' });
    expect(c.gateway.sendTransfer).toHaveBeenCalledWith(expect.objectContaining({ amount: 12000, reference: 'pp_po1_1', beneficiary: { name: 'Awa Ngono', phone: '+237670000000', channel: 'cm.mtn' } }));
    expect(c.prisma.partnerPayout.updateMany.mock.calls.some(([a]) => (a as { data: { status?: string } }).data.status === 'PAID')).toBe(true);
    expect(c.notifications.notify).toHaveBeenCalledWith('pu1', 'PARTNER_PAYOUT_SENT', { amount: 12000 });
  });
  it('refuse si l\'identité n\'est pas vérifiée, sans rien réserver', async () => {
    const c = make({ ...PAYOUT, partner: { status: 'ACTIVE', user: { fullName: 'Awa Ngono', kycStatus: 'REJECTED' } } });
    await expect(c.service.send('po1', 'fin')).rejects.toBeInstanceOf(ConflictException);
    expect(c.prisma.$transaction).not.toHaveBeenCalled();
    expect(c.gateway.sendTransfer).not.toHaveBeenCalled();
  });
  it('refuse si le nom du compte ne correspond pas', async () => {
    const c = make({ ...PAYOUT, accountName: 'Paul Essomba' });
    await expect(c.service.send('po1', 'fin')).rejects.toBeInstanceOf(ConflictException);
  });
  it('refuse un partenaire suspendu', async () => {
    const c = make({ ...PAYOUT, partner: { status: 'SUSPENDED', user: { fullName: 'Awa Ngono', kycStatus: 'APPROVED' } } });
    await expect(c.service.send('po1', 'fin')).rejects.toBeInstanceOf(ConflictException);
  });
  it('deux clics simultanés : un seul envoi', async () => {
    const c = make(PAYOUT, 0);
    await expect(c.service.send('po1', 'fin')).rejects.toBeInstanceOf(ConflictException);
    expect(c.gateway.sendTransfer).not.toHaveBeenCalled();
  });
  it('refus clair de Notch Pay : FAILED, réessai permis', async () => {
    const c = make();
    c.gateway.sendTransfer.mockRejectedValue(new ServiceUnavailableException('Solde insuffisant'));
    await c.service.send('po1', 'fin');
    expect(c.prisma.partnerPayout.updateMany.mock.calls.some(([a]) => (a as { data: { status?: string } }).data.status === 'FAILED')).toBe(true);
  });
  it('réponse inconnue (502) : reste SENDING, jamais FAILED', async () => {
    const c = make();
    c.gateway.sendTransfer.mockRejectedValue(new BadGatewayException('timeout'));
    await c.service.send('po1', 'fin');
    const statuses = c.prisma.partnerPayout.updateMany.mock.calls.map(([a]) => (a as { data: { status?: string } }).data.status);
    expect(statuses).not.toContain('FAILED');
    expect(statuses).not.toContain('PAID');
  });
  it('refuse un retrait déjà en cours', async () => {
    const c = make({ ...PAYOUT, status: 'SENDING' });
    await expect(c.service.send('po1', 'fin')).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('PartnersAdminService autres actions', () => {
  it('refuse un retrait avec motif, puis notifie le partenaire', async () => {
    const c = make({ ...PAYOUT, partner: { userId: 'pu1' } });
    await c.service.reject('po1', 'fin', 'Numéro invalide');
    expect(c.tx.partnerPayout.updateMany.mock.calls[0]![0]).toMatchObject({ data: { status: 'REJECTED', decidedNote: 'Numéro invalide' } });
    expect(c.notifications.notify).toHaveBeenCalledWith('pu1', 'PARTNER_PAYOUT_REJECTED', { reason: 'Numéro invalide' });
  });
  it('« marquer payé » refuse si un envoi est en vol', async () => {
    const c = make({ ...PAYOUT, status: 'SENDING' });
    await expect(c.service.markPaid('po1', 'fin', 'OM123')).rejects.toBeInstanceOf(ConflictException);
  });
  it('suspension : motif obligatoire', async () => {
    const c = make();
    await expect(c.service.setSuspended('pa1', 'adm', true, '  ')).rejects.toBeInstanceOf(BadRequestException);
    expect(c.prisma.partnerProfile.updateMany).not.toHaveBeenCalled();
  });
  it('réglages : n\'écrit que les champs fournis et journalise', async () => {
    const c = make();
    await c.service.updateConfig('adm', { hostRatePercent: 15, capPercent: undefined });
    expect(c.prisma.partnerConfig.update).toHaveBeenCalledWith({ where: { id: 'default' }, data: { hostRatePercent: 15, updatedById: 'adm' } });
    expect(c.prisma.auditLog.create).toHaveBeenCalled();
  });
});

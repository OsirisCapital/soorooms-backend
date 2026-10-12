import { describe, expect, it, vi } from 'vitest';
import { VisitPaymentsService } from './visit-payments.service.js';

function setup(task: Record<string, unknown> | null = { id: 't1', propertyId: 'p1', status: 'AWAITING_PAYMENT', amount: 10000, property: { id: 'p1', title: 'Studio' } }) {
  const prisma = {
    verificationTask: { findUnique: vi.fn().mockResolvedValue(task), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    propertyCollaborator: { findFirst: vi.fn().mockResolvedValue({ id: 'c1' }) },
    user: { findUnique: vi.fn().mockResolvedValue({ fullName: 'Hôte', phone: '+237677123456', email: null }) },
  };
  const gateway = {
    initiatePayment: vi.fn().mockResolvedValue({ paymentUrl: 'https://pay', gatewayRef: 'g1' }),
    verifyPayment: vi.fn(),
  };
  const config = { get: vi.fn().mockReturnValue('https://front') };
  const notifications = { notifyMany: vi.fn(), notifyStaff: vi.fn() };
  const service = new VisitPaymentsService(prisma as never, config as never, gateway as never, notifications as never);
  return { service, prisma, gateway, notifications };
}
const ok = (over = {}) => ({ status: 'SUCCESS', amount: 10000, currency: 'XAF', gatewayRef: 'g1', bookingReference: 't1', ...over });

describe('VisitPaymentsService', () => {
  it("lance le paiement au montant figé, avec l'id de la visite dans la référence", async () => {
    const { service, gateway } = setup();
    await service.initiate('t1', 'u1');
    expect(gateway.initiatePayment).toHaveBeenCalledWith(expect.objectContaining({ amount: 10000, currency: 'XAF', reference: expect.stringMatching(/^t1_/) }));
  });
  it('refuse de payer deux fois', async () => {
    const { service } = setup({ id: 't1', propertyId: 'p1', status: 'PENDING_ASSIGNMENT', amount: 10000, property: { id: 'p1', title: 'S' } });
    await expect(service.initiate('t1', 'u1')).rejects.toThrow(/déjà payée/);
  });
  it('confirme au retour quand le paiement est bon, et prévient hôte + équipe', async () => {
    const { service, gateway, prisma, notifications } = setup();
    gateway.verifyPayment.mockResolvedValue(ok());
    prisma.verificationTask.findUnique.mockResolvedValueOnce({ id: 't1', propertyId: 'p1', status: 'AWAITING_PAYMENT', amount: 10000, property: { id: 'p1', title: 'Studio' } })
      .mockResolvedValueOnce({ id: 't1', property: { id: 'p1', title: 'Studio', collaborators: [{ userId: 'host1' }] } });
    const res = await service.verifyReturn('t1', 'u1', 'ref');
    expect(res).toEqual({ confirmed: true, paymentStatus: 'SUCCESS' });
    expect(prisma.verificationTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 't1', status: 'AWAITING_PAYMENT' }, data: expect.objectContaining({ status: 'PENDING_ASSIGNMENT', paymentGatewayId: 'g1' }) }),
    );
    expect(notifications.notifyMany).toHaveBeenCalledWith(['host1'], 'VISIT_PAID', expect.anything());
    expect(notifications.notifyStaff).toHaveBeenCalledWith('visits.manage', 'VISIT_PAID_STAFF', { propertyTitle: 'Studio' });
  });
  it("refuse un paiement qui désigne une autre visite", async () => {
    const { service, gateway, prisma } = setup();
    gateway.verifyPayment.mockResolvedValue(ok({ bookingReference: 'autre' }));
    await expect(service.verifyReturn('t1', 'u1', 'ref')).rejects.toThrow(/ne correspond pas/);
    expect(prisma.verificationTask.updateMany).not.toHaveBeenCalled();
  });
  it('refuse un montant ou une devise inattendus', async () => {
    const { service, gateway } = setup();
    gateway.verifyPayment.mockResolvedValue(ok({ amount: 500 }));
    await expect(service.verifyReturn('t1', 'u1', 'ref')).rejects.toThrow(/Montant/);
    gateway.verifyPayment.mockResolvedValue(ok({ currency: 'EUR' }));
    await expect(service.verifyReturn('t1', 'u1', 'ref')).rejects.toThrow(/Devise/);
  });
  it("laisse l'hôte réessayer quand le paiement est en cours ou échoué", async () => {
    const { service, gateway } = setup();
    gateway.verifyPayment.mockResolvedValue(ok({ status: 'PENDING' }));
    expect(await service.verifyReturn('t1', 'u1', 'ref')).toEqual({ confirmed: false, paymentStatus: 'PENDING' });
    gateway.verifyPayment.mockResolvedValue(ok({ status: 'FAILED' }));
    expect(await service.verifyReturn('t1', 'u1', 'ref')).toEqual({ confirmed: false, paymentStatus: 'FAILED' });
  });
  it("le webhook ignore un échec et ne recoupe que les succès", async () => {
    const { service, gateway, prisma } = setup();
    await service.handleWebhook({ gatewayRef: 'g1', status: 'FAILED', amount: 0, paymentMethod: 'MTN_MOMO', bookingReference: 't1' } as never);
    expect(gateway.verifyPayment).not.toHaveBeenCalled();
    gateway.verifyPayment.mockResolvedValue(ok());
    await service.handleWebhook({ gatewayRef: 'g1', status: 'SUCCESS', amount: 10000, paymentMethod: 'MTN_MOMO', bookingReference: 't1' } as never);
    expect(prisma.verificationTask.updateMany).toHaveBeenCalled();
  });
});

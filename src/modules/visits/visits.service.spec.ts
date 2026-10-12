import { describe, expect, it, vi } from 'vitest';
import { CHECKLIST_KEYS } from './visit.utils.js';
import { VisitsService } from './visits.service.js';

const grid = (value = true) => Object.fromEntries(CHECKLIST_KEYS.map((k) => [k, value]));
const photos = ['https://a/1.jpg', 'https://a/2.jpg', 'https://a/3.jpg'];

function setup(over: Record<string, unknown> = {}) {
  const prisma = {
    propertyCollaborator: { findFirst: vi.fn().mockResolvedValue({ id: 'c1' }), findMany: vi.fn().mockResolvedValue([{ userId: 'host1' }]) },
    property: { findUnique: vi.fn().mockResolvedValue({ id: 'p1', status: 'ACTIVE', isVerifiedByAgent: false }), update: vi.fn() },
    verificationTask: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: 't1', status: 'AWAITING_PAYMENT', amount: 10000 }),
      update: vi.fn().mockResolvedValue({ id: 't1', status: 'AWAITING_PAYMENT', amount: 10000 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    user: { findMany: vi.fn().mockResolvedValue([{ id: 'ag1', fullName: 'Agent', role: 'ADMIN', staffRole: 'FIELD_AGENT', staffPermissions: [] }]) },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    ...over,
  };
  const fees = { visitPrice: vi.fn().mockResolvedValue(10000) };
  const notifications = { notify: vi.fn(), notifyMany: vi.fn() };
  const service = new VisitsService(prisma as never, fees as never, notifications as never);
  return { service, prisma, notifications };
}

describe('VisitsService.request', () => {
  it("refuse quelqu'un qui n'est pas gérant", async () => {
    const { service, prisma } = setup();
    prisma.propertyCollaborator.findFirst.mockResolvedValue(null);
    await expect(service.request('p1', 'u1')).rejects.toThrow(/gérant/);
  });
  it('crée une demande à payer au prix en vigueur', async () => {
    const { service, prisma } = setup();
    await service.request('p1', 'u1');
    expect(prisma.verificationTask.create).toHaveBeenCalledWith({
      data: { propertyId: 'p1', requestType: 'EXPRESS_PAID', status: 'AWAITING_PAYMENT', requestedById: 'u1', amount: 10000 },
    });
  });
  it('refuse un logement déjà vérifié', async () => {
    const { service, prisma } = setup();
    prisma.property.findUnique.mockResolvedValue({ id: 'p1', status: 'ACTIVE', isVerifiedByAgent: true });
    await expect(service.request('p1', 'u1')).rejects.toThrow(/déjà vérifié/);
  });
  it('reprend une demande non payée au lieu d’en créer une seconde', async () => {
    const { service, prisma } = setup();
    prisma.verificationTask.findFirst.mockResolvedValue({ id: 't1', status: 'AWAITING_PAYMENT' });
    await service.request('p1', 'u1');
    expect(prisma.verificationTask.create).not.toHaveBeenCalled();
    expect(prisma.verificationTask.update).toHaveBeenCalledWith({ where: { id: 't1' }, data: { amount: 10000 } });
  });
  it('refuse si une visite payée est déjà en cours', async () => {
    const { service, prisma } = setup();
    prisma.verificationTask.findFirst.mockResolvedValue({ id: 't1', status: 'ASSIGNED' });
    await expect(service.request('p1', 'u1')).rejects.toThrow(/déjà payée/);
  });
});

describe('VisitsService.assign', () => {
  it("refuse quelqu'un qui n'est pas agent de terrain", async () => {
    const { service } = setup();
    await expect(service.assign('t1', 'inconnu')).rejects.toThrow(/Agent de terrain/);
  });
  it("assigne et prévient l'agent", async () => {
    const { service, prisma, notifications } = setup();
    prisma.verificationTask.findUnique.mockResolvedValue({ id: 't1', property: { title: 'Studio', city: 'Douala' } });
    await service.assign('t1', 'ag1');
    expect(prisma.verificationTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 't1', status: { in: ['PENDING_ASSIGNMENT', 'ASSIGNED'] } } }),
    );
    expect(notifications.notify).toHaveBeenCalledWith('ag1', 'VISIT_ASSIGNED', { visitId: 't1', propertyTitle: 'Studio', city: 'Douala' });
  });
  it('refuse une visite non payée ou terminée', async () => {
    const { service, prisma } = setup();
    prisma.verificationTask.findUnique.mockResolvedValue({ id: 't1', property: { title: 'S', city: 'D' } });
    prisma.verificationTask.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.assign('t1', 'ag1')).rejects.toThrow(/n'attend plus/);
  });
});

describe('VisitsService.submit', () => {
  const task = { id: 't1', propertyId: 'p1', agentId: 'ag1', status: 'ASSIGNED', property: { id: 'p1', title: 'Studio' } };
  const dto = (over = {}) => ({ conforming: true, checklist: grid(), photoUrls: photos, report: '', ...over });

  it("refuse l'agent à qui la visite n'est pas confiée", async () => {
    const { service, prisma } = setup();
    prisma.verificationTask.findUnique.mockResolvedValue(task);
    await expect(service.submit('t1', 'autre', dto())).rejects.toThrow(/ne vous est pas confiée/);
  });
  it('accorde le badge quand tout est conforme', async () => {
    const { service, prisma, notifications } = setup();
    prisma.verificationTask.findUnique.mockResolvedValue(task);
    await service.submit('t1', 'ag1', dto());
    expect(prisma.property.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'p1' }, data: expect.objectContaining({ isVerifiedByAgent: true, verificationType: 'EXPRESS_PAID' }) }),
    );
    expect(notifications.notifyMany).toHaveBeenCalledWith(['host1'], 'VISIT_DONE', { propertyId: 'p1', propertyTitle: 'Studio', conforming: true });
  });
  it('refuse « conforme » quand un point de la grille est faux', async () => {
    const { service, prisma } = setup();
    prisma.verificationTask.findUnique.mockResolvedValue(task);
    await expect(service.submit('t1', 'ag1', dto({ checklist: { ...grid(), utilities: false } }))).rejects.toThrow(/tous les points/);
    expect(prisma.property.update).not.toHaveBeenCalled();
  });
  it('enregistre une non-conformité sans donner le badge', async () => {
    const { service, prisma } = setup();
    prisma.verificationTask.findUnique.mockResolvedValue(task);
    await service.submit('t1', 'ag1', dto({ conforming: false, checklist: { ...grid(), utilities: false }, report: "Pas d'eau dans la salle de bain." }));
    expect(prisma.verificationTask.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'REJECTED' }) }));
    expect(prisma.property.update).not.toHaveBeenCalled();
  });
  it('refuse une grille incomplète', async () => {
    const { service, prisma } = setup();
    prisma.verificationTask.findUnique.mockResolvedValue(task);
    await expect(service.submit('t1', 'ag1', dto({ checklist: { locationMatches: true } }))).rejects.toThrow(/grille/);
  });
  it('refuse une visite déjà terminée', async () => {
    const { service, prisma } = setup();
    prisma.verificationTask.findUnique.mockResolvedValue({ ...task, status: 'COMPLETED' });
    await expect(service.submit('t1', 'ag1', dto())).rejects.toThrow(/déjà terminée/);
  });
});

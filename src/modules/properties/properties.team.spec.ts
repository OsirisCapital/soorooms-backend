import { describe, expect, it, vi } from 'vitest';
import { PropertyCollaboratorGuard } from '../../common/guards/property-collaborator.guard.js';
import { COLLABORATOR_CAPABILITY_KEY } from '../../common/decorators/require-capability.decorator.js';
import { PropertiesService } from './properties.service.js';

function team(overrides: Record<string, unknown> = {}) {
  const prisma = {
    user: { findUnique: vi.fn().mockResolvedValue({ id: 'u2' }) },
    property: { findUnique: vi.fn().mockResolvedValue({ title: 'Villa' }) },
    propertyCollaborator: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn(),
      count: vi.fn().mockResolvedValue(1),
      create: vi.fn().mockResolvedValue({ id: 'c' }),
      update: vi.fn().mockResolvedValue({ id: 'c' }),
    },
    ...overrides,
  };
  const notifications = { notify: vi.fn() };
  return { service: new PropertiesService(prisma as never, notifications as never), prisma, notifications };
}

describe('équipe du logement', () => {
  it("invite et prévient la personne avec le libellé du rôle", async () => {
    const { service, notifications } = team();
    await service.inviteCollaborator('p1', { phone: '+237677123456', role: 'RECEPTIONIST' } as never);
    expect(notifications.notify).toHaveBeenCalledWith('u2', 'TEAM_ADDED', { propertyId: 'p1', propertyTitle: 'Villa', roleLabel: 'Réceptionniste' });
  });

  it('liste le gérant principal en premier', async () => {
    const { service, prisma } = team();
    prisma.propertyCollaborator.findMany.mockResolvedValue([
      { userId: 'a', role: 'ACCOUNTANT', user: { fullName: 'Awa', phone: '+2371' } },
      { userId: 'b', role: 'MANAGER', user: { fullName: 'Zoé', phone: '+2372' } },
    ]);
    const list = await service.listCollaborators('p1');
    expect(list.map((m) => m.userId)).toEqual(['b', 'a']);
  });

  it('change le rôle d’un membre', async () => {
    const { service, prisma } = team();
    prisma.propertyCollaborator.findUnique.mockResolvedValue({ role: 'AGENT' });
    await service.changeCollaboratorRole('p1', 'u2', 'ACCOUNTANT');
    expect(prisma.propertyCollaborator.update).toHaveBeenCalledWith(expect.objectContaining({ data: { role: 'ACCOUNTANT' } }));
  });

  it('refuse de rétrograder le dernier gérant principal', async () => {
    const { service, prisma } = team();
    prisma.propertyCollaborator.findUnique.mockResolvedValue({ role: 'MANAGER' });
    prisma.propertyCollaborator.count.mockResolvedValue(1);
    await expect(service.changeCollaboratorRole('p1', 'u1', 'AGENT')).rejects.toThrow(/dernier gérant/);
    expect(prisma.propertyCollaborator.update).not.toHaveBeenCalled();
  });
});

describe('PropertyCollaboratorGuard : droit par défaut', () => {
  function run(role: string, capability?: string) {
    const prisma = { propertyCollaborator: { findUnique: vi.fn().mockResolvedValue({ role }) } };
    const reflector = { getAllAndOverride: vi.fn((key: string) => (key === COLLABORATOR_CAPABILITY_KEY ? capability : undefined)) };
    const guard = new PropertyCollaboratorGuard(prisma as never, reflector as never);
    const ctx = {
      switchToHttp: () => ({ getRequest: () => ({ params: { id: 'p1' }, user: { id: 'u1' } }) }),
      getHandler: () => ({}),
      getClass: () => ({}),
    };
    return guard.canActivate(ctx as never);
  }
  it('sans droit déclaré, un réceptionniste ne modifie pas la fiche', async () => {
    await expect(run('RECEPTIONIST')).rejects.toThrow(/rôle/);
    await expect(run('ACCOUNTANT')).rejects.toThrow(/rôle/);
  });
  it('un gestionnaire ou un agent modifie la fiche', async () => {
    await expect(run('CO_MANAGER')).resolves.toBe(true);
    await expect(run('AGENT')).resolves.toBe(true);
  });
  it('un réceptionniste voit les réservations, pas un comptable', async () => {
    await expect(run('RECEPTIONIST', 'bookings.manage')).resolves.toBe(true);
    await expect(run('ACCOUNTANT', 'bookings.manage')).rejects.toThrow(/rôle/);
  });
});

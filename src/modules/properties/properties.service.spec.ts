import { describe, expect, it, vi } from 'vitest';
import { PropertiesService } from './properties.service.js';

const PROPERTY_ID = 'prop-1';

type Overrides = {
  user?: Record<string, unknown> | null;
  property?: Record<string, unknown> | null;
};

function setup(overrides: Overrides = {}) {
  const verifiedHost = { id: 'u1', emailVerifiedAt: new Date(), kycStatus: 'APPROVED' };
  const prisma = {
    user: { findUnique: vi.fn().mockResolvedValue(overrides.user === undefined ? verifiedHost : overrides.user) },
    property: {
      findUnique: vi
        .fn()
        .mockResolvedValue(overrides.property === undefined ? { id: PROPERTY_ID, status: 'DRAFT', _count: { rooms: 1 } } : overrides.property),
      update: vi.fn().mockResolvedValue({ id: PROPERTY_ID, status: 'ACTIVE' }),
    },
  };
  return { service: new PropertiesService(prisma as never), prisma };
}

describe('PropertiesService.publish', () => {
  it('publie quand l’adresse est vérifiée, le KYC approuvé et une chambre existe', async () => {
    const { service, prisma } = setup();
    await expect(service.publish(PROPERTY_ID, 'u1')).resolves.toMatchObject({ status: 'ACTIVE' });
    expect(prisma.property.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: PROPERTY_ID }, data: { status: 'ACTIVE' } }),
    );
  });

  it('refuse un hôte dont l’adresse e-mail n’est PAS vérifiée, même avec un KYC approuvé', async () => {
    const { service, prisma } = setup({ user: { id: 'u1', emailVerifiedAt: null, kycStatus: 'APPROVED' } });
    await expect(service.publish(PROPERTY_ID, 'u1')).rejects.toThrow(/Vérifiez votre adresse e-mail/);
    expect(prisma.property.update).not.toHaveBeenCalled();
  });

  it('refuse un hôte sans aucune adresse e-mail', async () => {
    const { service, prisma } = setup({ user: { id: 'u1', email: null, emailVerifiedAt: null, kycStatus: 'APPROVED' } });
    await expect(service.publish(PROPERTY_ID, 'u1')).rejects.toThrow(/Vérifiez votre adresse e-mail/);
    expect(prisma.property.update).not.toHaveBeenCalled();
  });

  it('refuse un compte introuvable', async () => {
    const { service, prisma } = setup({ user: null });
    await expect(service.publish(PROPERTY_ID, 'ghost')).rejects.toThrow(/Vérifiez votre adresse e-mail/);
    expect(prisma.property.update).not.toHaveBeenCalled();
  });

  it('signale l’e-mail avant le KYC quand les deux manquent (le plus rapide à régler d’abord)', async () => {
    const { service } = setup({ user: { id: 'u1', emailVerifiedAt: null, kycStatus: 'PENDING_REVIEW' } });
    await expect(service.publish(PROPERTY_ID, 'u1')).rejects.toThrow(/adresse e-mail/);
  });

  it('conserve le blocage KYC quand l’adresse est vérifiée mais le KYC non approuvé', async () => {
    const { service, prisma } = setup({ user: { id: 'u1', emailVerifiedAt: new Date(), kycStatus: 'PENDING_REVIEW' } });
    await expect(service.publish(PROPERTY_ID, 'u1')).rejects.toThrow(/KYC/);
    expect(prisma.property.update).not.toHaveBeenCalled();
  });

  it('conserve les autres règles : logement suspendu, sans chambre, introuvable', async () => {
    await expect(setup({ property: { id: PROPERTY_ID, status: 'SUSPENDED', _count: { rooms: 1 } } }).service.publish(PROPERTY_ID, 'u1')).rejects.toThrow(/suspendu/);
    await expect(setup({ property: { id: PROPERTY_ID, status: 'DRAFT', _count: { rooms: 0 } } }).service.publish(PROPERTY_ID, 'u1')).rejects.toThrow(/au moins une chambre/);
    await expect(setup({ property: null }).service.publish(PROPERTY_ID, 'u1')).rejects.toThrow(/introuvable/);
  });
});

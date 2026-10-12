import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import { attestationBlockers, buildAttestation, generateAttestationCode, isForeignCountry, normalizeAttestationCode, toPublicVerification } from './attestation.js';
import { AttestationsService } from './attestations.service.js';

const base = {
  id: '3f9a1c2b-0000-4000-8000-000000000000',
  status: 'CONFIRMED_ESCROW',
  travelerId: 't1',
  checkInDate: new Date('2027-01-10'),
  checkOutDate: new Date('2027-01-13'),
  guestName: 'Paul Ngo',
  traveler: { fullName: 'Marie Ngo', kycStatus: 'APPROVED' },
  room: { name: 'Ch 1', property: { title: 'Villa', city: 'Kribi', quarter: 'Mpalla', collaborators: [{ userId: 'h1', role: 'MANAGER' }, { userId: 'a1', role: 'AGENT' }] } },
  attestationCode: null as string | null,
  attestationSignedAt: null as Date | null,
  attestationSignerName: null as string | null,
  attestationRequestedAt: null as Date | null,
  attestationDeclinedAt: null as Date | null,
  attestationCountry: null as string | null,
  attestationDeclineReason: null as string | null,
  escrowVault: { status: 'HELD_IN_ESCROW' },
};

function setup(over: Record<string, unknown> = {}) {
  const booking = { ...base, ...over };
  const prisma = {
    booking: {
      findUnique: vi.fn().mockImplementation(async () => booking),
      updateMany: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(booking, data);
        return { count: 1 };
      }),
      update: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(booking, data);
        return booking;
      }),
    },
    user: { findUnique: vi.fn().mockResolvedValue({ fullName: 'Hôte Principal' }) },
  };
  const notifications = { notify: vi.fn().mockResolvedValue(true) };
  const service = new AttestationsService(prisma as unknown as PrismaService, notifications as unknown as NotificationsService);
  return { service, notifications, prisma };
}

describe('codes', () => {
  it('10 caractères sans ambiguïté, normalisés', () => {
    expect(generateAttestationCode()).toMatch(/^[A-HJKMNP-Z2-9]{10}$/);
    expect(normalizeAttestationCode(' ab12-cd34ef ')).toBe('AB12CD34EF');
  });
});

describe('attestation', () => {
  it('l’occupant est l’invité, sinon le voyageur ; la vérification publique reste minimale', () => {
    const a = buildAttestation({ ...base, attestationCode: 'ABCDEFGH23', attestationSignedAt: new Date(), attestationSignerName: 'Hôte' })!;
    expect(a.occupantName).toBe('Paul Ngo');
    expect(a.valid).toBe(true);
    expect(JSON.stringify(toPublicVerification(a))).not.toContain('Marie');
    const b = buildAttestation({ ...base, guestName: null, attestationCode: 'ABCDEFGH23', attestationSignedAt: new Date(), attestationSignerName: 'Hôte' })!;
    expect(b.occupantName).toBe('Marie Ngo');
  });

  it('devient invalide après annulation ou remboursement', () => {
    const signed = { attestationCode: 'ABCDEFGH23', attestationSignedAt: new Date(), attestationSignerName: 'H' };
    expect(buildAttestation({ ...base, ...signed, status: 'CANCELLED' })!.valid).toBe(false);
    expect(buildAttestation({ ...base, ...signed, escrowVault: { status: 'REFUNDED_TO_TRAVELER' } })!.valid).toBe(false);
  });
});

describe('conditions', () => {
  it('étranger : tout sauf le Cameroun, accents et casse ignorés', () => {
    expect(isForeignCountry('France')).toBe(true);
    expect(isForeignCountry(' Côte d’Ivoire ')).toBe(true);
    expect(isForeignCountry('CAMEROUN')).toBe(false);
    expect(isForeignCountry('Cameroon')).toBe(false);
    expect(isForeignCountry('x')).toBe(false);
  });
  it('bloqueurs : paiement et identité vérifiée', () => {
    expect(attestationBlockers({ status: 'CONFIRMED_ESCROW', travelerKycStatus: 'APPROVED' })).toEqual([]);
    expect(attestationBlockers({ status: 'PENDING_PAYMENT', travelerKycStatus: 'NONE' })).toHaveLength(2);
  });
});

describe('AttestationsService', () => {
  const requested = { attestationRequestedAt: new Date(), attestationCountry: 'France' };

  it('la demande exige identité vérifiée, paiement et pays étranger', async () => {
    await expect(setup({ traveler: { fullName: 'M', kycStatus: 'PENDING' } }).service.request('b', 't1', 'France')).rejects.toThrow(/identité/);
    await expect(setup({ status: 'PENDING_PAYMENT' }).service.request('b', 't1', 'France')).rejects.toThrow(/payée/);
    await expect(setup().service.request('b', 't1', 'Cameroun')).rejects.toThrow(/étranger/);
    await expect(setup().service.request('b', 'h1', 'France')).rejects.toThrow(/voyageur/);
  });

  it('demande valide : état REQUESTED et seuls les gérants sont prévenus', async () => {
    const { service, notifications } = setup();
    expect((await service.state('b', 't1')).status).toBe('AVAILABLE');
    await service.request('b', 't1', 'France');
    expect(notifications.notify).toHaveBeenCalledTimes(1);
    expect(notifications.notify).toHaveBeenCalledWith('h1', 'ATTESTATION_REQUESTED', expect.anything());
    expect((await service.state('b', 'h1')).status).toBe('REQUESTED');
  });

  it('sans demande, personne ne peut signer', async () => {
    await expect(setup().service.sign('b', 'h1')).rejects.toThrow(/pas demandé/);
  });

  it('seul un gérant signe, une seule fois, et le voyageur est prévenu', async () => {
    const { service, notifications } = setup(requested);
    await expect(service.sign('b', 'a1')).rejects.toThrow(/gérant/);
    await expect(service.sign('b', 'inconnu')).rejects.toThrow(/gérant/);
    const first = await service.sign('b', 'h1');
    expect(first?.signerName).toBe('Hôte Principal');
    expect(notifications.notify).toHaveBeenCalledWith('t1', 'ATTESTATION_SIGNED', expect.anything());
    const again = await service.sign('b', 'h1');
    expect(again?.code).toBe(first?.code);
    expect(notifications.notify).toHaveBeenCalledTimes(1);
    expect((await service.state('b', 't1')).status).toBe('SIGNED');
  });

  it('refus motivé : le voyageur est prévenu, voit le motif et peut redemander', async () => {
    const { service, notifications } = setup(requested);
    await expect(service.decline('b', 'a1', 'Dates non conformes')).rejects.toThrow(/gérant/);
    await service.decline('b', 'h1', 'Dates non conformes');
    expect(notifications.notify).toHaveBeenCalledWith('t1', 'ATTESTATION_DECLINED', expect.objectContaining({ reason: 'Dates non conformes' }));
    const state = await service.state('b', 't1');
    expect(state).toMatchObject({ status: 'DECLINED', declineReason: 'Dates non conformes' });
    await service.request('b', 't1', 'France');
    expect((await service.state('b', 't1')).status).toBe('REQUESTED');
  });

  it('état : non éligible avec raisons, et accès refusé aux étrangers à la réservation', async () => {
    const state = await setup({ status: 'PENDING_PAYMENT' }).service.state('b', 't1');
    expect(state.status).toBe('NOT_ELIGIBLE');
    expect(state.reasons.length).toBeGreaterThan(0);
    await expect(setup().service.state('b', 'x')).rejects.toThrow(/partie prenante/);
  });

  it('vérification publique : code inconnu → introuvable, code valide → données minimales', async () => {
    const unknown = setup();
    await expect(unknown.service.verify('zzzzzzzzzz')).rejects.toThrow(/Aucune attestation/);
    const { service } = setup({ attestationCode: 'ABCDEFGH23', attestationSignedAt: new Date(), attestationSignerName: 'Hôte' });
    const result = await service.verify('abcdefgh-23');
    expect(result).toMatchObject({ valid: true, occupantName: 'Paul Ngo' });
  });
});

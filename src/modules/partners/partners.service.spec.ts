import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { PartnersService } from './partners.service.js';

const CONFIG = { id: 'default', enabled: true, hostRatePercent: 20, hostMonths: 18, travelerRatePercent: 10, travelerMonths: 6, capPercent: 30, minPayout: 5000, withholdingPercent: 0, claimWindowDays: 14, termsVersion: '2026-10' };
const P2002 = Object.assign(new Error('unique'), { code: 'P2002' });

function make(over: Record<string, unknown> = {}) {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    partnerCommission: { aggregate: vi.fn().mockResolvedValue({ _sum: { amount: 0 } }), create: vi.fn().mockResolvedValue({}) },
    partnerPayout: {
      findFirst: vi.fn().mockResolvedValue(null),
      aggregate: vi.fn().mockResolvedValue({ _sum: { gross: 0 } }),
      create: vi.fn().mockImplementation(async ({ data }: { data: { net: number } }) => ({ id: 'po1', net: data.net })),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    partnerConfig: { findUnique: vi.fn().mockResolvedValue(CONFIG), create: vi.fn() },
    partnerProfile: { findUnique: vi.fn(), create: vi.fn().mockResolvedValue({}), update: vi.fn() },
    partnerReferral: { findUnique: vi.fn().mockResolvedValue(null), findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 1 }), count: vi.fn().mockResolvedValue(0) },
    partnerCommission: { aggregate: vi.fn().mockResolvedValue({ _sum: { amount: 0 } }) },
    partnerPayout: { aggregate: vi.fn().mockResolvedValue({ _sum: { gross: 0, net: 0 } }), findFirst: vi.fn().mockResolvedValue(null) },
    user: { findUnique: vi.fn() },
    booking: { findUnique: vi.fn(), count: vi.fn().mockResolvedValue(0) },
    hostProfile: { findUnique: vi.fn().mockResolvedValue({ payoutPhone: '+237699999999' }) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    ...over,
  };
  const notifications = { notify: vi.fn().mockResolvedValue(undefined), notifyStaff: vi.fn().mockResolvedValue(undefined) };
  return { service: new PartnersService(prisma as never, notifications as never), prisma, tx, notifications };
}

describe('PartnersService.activate', () => {
  it('refuse sans acceptation des conditions', async () => {
    const c = make();
    await expect(c.service.activate('u1', false)).rejects.toBeInstanceOf(BadRequestException);
  });
  it("refuse un compte de l'équipe", async () => {
    const c = make();
    c.prisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
    await expect(c.service.activate('u1', true)).rejects.toBeInstanceOf(ForbiddenException);
    expect(c.prisma.partnerProfile.create).not.toHaveBeenCalled();
  });
  it('crée le compte avec la version des conditions et l\'horodatage', async () => {
    const c = make();
    c.prisma.user.findUnique.mockResolvedValue({ role: 'TRAVELER' });
    c.prisma.partnerProfile.findUnique.mockResolvedValue(null);
    vi.spyOn(c.service, 'me').mockResolvedValue({ partner: null } as never);
    await c.service.activate('u1', true);
    const data = c.prisma.partnerProfile.create.mock.calls[0]![0].data;
    expect(data.userId).toBe('u1');
    expect(data.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(data.termsVersion).toBe('2026-10');
    expect(data.termsAcceptedAt).toBeInstanceOf(Date);
  });
  it('réessaie avec un autre code si le code est déjà pris', async () => {
    const c = make();
    c.prisma.user.findUnique.mockResolvedValue({ role: 'TRAVELER' });
    c.prisma.partnerProfile.findUnique.mockResolvedValue(null);
    c.prisma.partnerProfile.create.mockRejectedValueOnce(P2002).mockResolvedValueOnce({});
    vi.spyOn(c.service, 'me').mockResolvedValue({ partner: null } as never);
    await c.service.activate('u1', true);
    expect(c.prisma.partnerProfile.create).toHaveBeenCalledTimes(2);
  });
});

describe('PartnersService.claim', () => {
  const partner = { id: 'pa1', userId: 'partner-user', status: 'ACTIVE' };
  const fresh = { role: 'TRAVELER', createdAt: new Date(), fullName: 'Awa Ngono', partnerProfile: null };
  function ready() {
    const c = make();
    c.prisma.partnerProfile.findUnique.mockResolvedValue(partner);
    c.prisma.user.findUnique.mockResolvedValue(fresh);
    return c;
  }
  it('rattache un compte neuf et prévient le partenaire', async () => {
    const c = ready();
    await expect(c.service.claim('u1', 'abc-123')).resolves.toEqual({ ok: true, already: false });
    const data = c.prisma.partnerReferral.create.mock.calls[0]![0].data;
    expect(data.partnerId).toBe('pa1');
    expect(data.travelerEndsAt.getTime()).toBeGreaterThan(Date.now() + 170 * 86400000);
    expect(c.notifications.notify).toHaveBeenCalledWith('partner-user', 'PARTNER_REFERRAL_JOINED', { name: 'Awa' });
  });
  it('refuse son propre code', async () => {
    const c = ready();
    await expect(c.service.claim('partner-user', 'ABC123')).rejects.toBeInstanceOf(BadRequestException);
  });
  it('refuse un code inconnu ou suspendu', async () => {
    const c = ready();
    c.prisma.partnerProfile.findUnique.mockResolvedValue({ ...partner, status: 'SUSPENDED' });
    await expect(c.service.claim('u1', 'ABC123')).rejects.toBeInstanceOf(NotFoundException);
  });
  it('est idempotent avec le même parrain, refuse un second parrain', async () => {
    const c = ready();
    c.prisma.partnerReferral.findUnique.mockResolvedValue({ partnerId: 'pa1' });
    await expect(c.service.claim('u1', 'ABC123')).resolves.toEqual({ ok: true, already: true });
    c.prisma.partnerReferral.findUnique.mockResolvedValue({ partnerId: 'autre' });
    await expect(c.service.claim('u1', 'ABC123')).rejects.toBeInstanceOf(ConflictException);
  });
  it('refuse un compte trop ancien ou qui a déjà réservé', async () => {
    const c = ready();
    c.prisma.user.findUnique.mockResolvedValue({ ...fresh, createdAt: new Date(Date.now() - 20 * 86400000) });
    await expect(c.service.claim('u1', 'ABC123')).rejects.toBeInstanceOf(ConflictException);
    c.prisma.user.findUnique.mockResolvedValue(fresh);
    c.prisma.booking.count.mockResolvedValue(1);
    await expect(c.service.claim('u1', 'ABC123')).rejects.toBeInstanceOf(ConflictException);
  });
  it('refuse une boucle (A parraine B, puis B parraine A)', async () => {
    const c = ready();
    c.prisma.user.findUnique.mockResolvedValue({ ...fresh, partnerProfile: { id: 'mine' } });
    c.prisma.partnerReferral.findFirst.mockResolvedValue({ id: 'r' });
    await expect(c.service.claim('u1', 'ABC123')).rejects.toBeInstanceOf(ConflictException);
  });
  it('refuse un compte de l\'équipe', async () => {
    const c = ready();
    c.prisma.user.findUnique.mockResolvedValue({ ...fresh, role: 'ADMIN' });
    await expect(c.service.claim('u1', 'ABC123')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('PartnersService.accrueForBooking', () => {
  const booking = (over: object = {}) => ({
    createdAt: new Date('2026-11-01T10:00:00Z'),
    status: 'COMPLETED',
    travelerId: 'trav',
    room: { property: { title: 'Studio', collaborators: [{ userId: 'host' }] } },
    escrowVault: { platformFee: 1500 },
    ...over,
  });
  const hostRef = (over: object = {}) => ({ id: 'ref1', referredUserId: 'host', hostEndsAt: null, travelerEndsAt: new Date('2027-05-01'), partner: { id: 'pa1', userId: 'pu1', status: 'ACTIVE', payoutPhone: '+237670000000' }, ...over });
  function ready(b: object, refs: object[]) {
    const c = make();
    c.prisma.booking.findUnique.mockResolvedValue(b);
    c.prisma.partnerReferral.findMany.mockResolvedValue(refs);
    return c;
  }

  it('crédite 20 % du revenu conservé et ouvre la fenêtre de 18 mois à la première réservation', async () => {
    const c = ready(booking(), [hostRef()]);
    await c.service.accrueForBooking('b1');
    const created = c.tx.partnerCommission.create.mock.calls[0]![0].data;
    expect(created).toMatchObject({ partnerId: 'pa1', bookingId: 'b1', kind: 'HOST', revenue: 1500, ratePercent: 20, amount: 300 });
    const win = c.prisma.partnerReferral.updateMany.mock.calls[0]![0];
    expect(win.where).toEqual({ id: 'ref1', hostEndsAt: null });
    expect(win.data.hostEndsAt.toISOString()).toBe('2028-05-01T10:00:00.000Z');
    expect(c.notifications.notify).toHaveBeenCalledWith('pu1', 'PARTNER_COMMISSION_EARNED', { amount: 300, kind: 'HOST', propertyTitle: 'Studio' });
  });
  it('ne crédite plus après la fin de la fenêtre', async () => {
    const c = ready(booking(), [hostRef({ hostEndsAt: new Date('2026-10-31') })]);
    await c.service.accrueForBooking('b1');
    expect(c.tx.partnerCommission.create).not.toHaveBeenCalled();
  });
  it('ne crédite rien si SòôRooms ne garde aucun revenu (remboursement intégral)', async () => {
    const c = ready(booking({ escrowVault: { platformFee: 0 } }), [hostRef()]);
    await c.service.accrueForBooking('b1');
    expect(c.prisma.partnerReferral.findMany).not.toHaveBeenCalled();
  });
  it("ne crédite rien tant que la réservation n'est ni terminée ni annulée", async () => {
    const c = ready(booking({ status: 'CONFIRMED_ESCROW' }), [hostRef()]);
    await c.service.accrueForBooking('b1');
    expect(c.tx.partnerCommission.create).not.toHaveBeenCalled();
  });
  it('ne crédite rien sur ses propres logements ni ses propres réservations', async () => {
    const own = ready(booking(), [hostRef({ partner: { id: 'pa1', userId: 'host', status: 'ACTIVE', payoutPhone: null } })]);
    await own.service.accrueForBooking('b1');
    expect(own.tx.partnerCommission.create).not.toHaveBeenCalled();
    const asTraveler = ready(booking(), [hostRef({ partner: { id: 'pa1', userId: 'trav', status: 'ACTIVE', payoutPhone: null } })]);
    await asTraveler.service.accrueForBooking('b1');
    expect(asTraveler.tx.partnerCommission.create).not.toHaveBeenCalled();
  });
  it("ne crédite rien si le partenaire est payé sur le même numéro que l'hôte", async () => {
    const c = ready(booking(), [hostRef({ partner: { id: 'pa1', userId: 'pu1', status: 'ACTIVE', payoutPhone: '+237699999999' } })]);
    await c.service.accrueForBooking('b1');
    expect(c.tx.partnerCommission.create).not.toHaveBeenCalled();
  });
  it('ne crédite rien à un partenaire suspendu', async () => {
    const c = ready(booking(), [hostRef({ partner: { id: 'pa1', userId: 'pu1', status: 'SUSPENDED', payoutPhone: null } })]);
    await c.service.accrueForBooking('b1');
    expect(c.tx.partnerCommission.create).not.toHaveBeenCalled();
  });
  it('crédite 10 % pour un voyageur parrainé, dans sa fenêtre de 6 mois', async () => {
    const trav = { id: 'ref2', referredUserId: 'trav', hostEndsAt: null, travelerEndsAt: new Date('2027-02-01'), partner: { id: 'pa2', userId: 'pu2', status: 'ACTIVE', payoutPhone: null } };
    const c = ready(booking(), [trav]);
    await c.service.accrueForBooking('b1');
    expect(c.tx.partnerCommission.create.mock.calls[0]![0].data).toMatchObject({ kind: 'TRAVELER', ratePercent: 10, amount: 150 });
    const late = ready(booking({ createdAt: new Date('2027-03-01') }), [trav]);
    await late.service.accrueForBooking('b1');
    expect(late.tx.partnerCommission.create).not.toHaveBeenCalled();
  });
  it('respecte le plafond cumulé quand deux partenaires sont en jeu', async () => {
    const trav = { id: 'ref2', referredUserId: 'trav', hostEndsAt: null, travelerEndsAt: new Date('2027-02-01'), partner: { id: 'pa2', userId: 'pu2', status: 'ACTIVE', payoutPhone: null } };
    const c = ready(booking({ escrowVault: { platformFee: 1000 } }), [trav, hostRef()]);
    c.tx.partnerCommission.aggregate.mockResolvedValueOnce({ _sum: { amount: 0 } }).mockResolvedValueOnce({ _sum: { amount: 200 } });
    await c.service.accrueForBooking('b1');
    const kinds = c.tx.partnerCommission.create.mock.calls.map((x) => x[0].data.kind);
    expect(kinds).toEqual(['HOST', 'TRAVELER']); // l'hôte passe d'abord
    expect(c.tx.partnerCommission.create.mock.calls[1]![0].data.amount).toBe(100);
  });
  it('rejouer ne crédite pas deux fois (index unique)', async () => {
    const c = ready(booking(), [hostRef({ hostEndsAt: new Date('2028-01-01') })]);
    c.tx.partnerCommission.create.mockRejectedValue(P2002);
    await expect(c.service.accrueForBooking('b1')).resolves.toBeUndefined();
    expect(c.notifications.notify).not.toHaveBeenCalled();
  });
  it('ne lève jamais, même si la base échoue', async () => {
    const c = make();
    c.prisma.booking.findUnique.mockRejectedValue(new Error('db down'));
    await expect(c.service.accrueForBooking('b1')).resolves.toBeUndefined();
  });
  it('ne fait rien quand le programme est fermé', async () => {
    const c = ready(booking(), [hostRef()]);
    c.prisma.partnerConfig.findUnique.mockResolvedValue({ ...CONFIG, enabled: false });
    await c.service.accrueForBooking('b1');
    expect(c.prisma.booking.findUnique).not.toHaveBeenCalled();
  });
});

describe('PartnersService.requestPayout', () => {
  const partner = { id: 'pa1', userId: 'u1', status: 'ACTIVE', payoutChannel: 'cm.mtn', payoutPhone: '+237670000000', payoutAccountName: 'Awa Ngono', payoutUpdatedAt: new Date('2026-01-01') };
  function ready(over: { user?: object; partner?: object; earned?: number; reserved?: number } = {}) {
    const c = make();
    c.prisma.partnerProfile.findUnique.mockResolvedValue({ ...partner, ...over.partner });
    c.prisma.user.findUnique.mockResolvedValue({ fullName: 'Awa Ngono', kycStatus: 'APPROVED', ...over.user });
    c.tx.partnerCommission.aggregate.mockResolvedValue({ _sum: { amount: over.earned ?? 12000 } });
    c.tx.partnerPayout.aggregate.mockResolvedValue({ _sum: { gross: over.reserved ?? 0 } });
    vi.spyOn(c.service, 'me').mockResolvedValue({} as never);
    return c;
  }
  it('retire tout le solde disponible et prévient la finance', async () => {
    const c = ready();
    await c.service.requestPayout('u1');
    expect(c.tx.partnerPayout.create.mock.calls[0]![0].data).toMatchObject({ partnerId: 'pa1', gross: 12000, withholding: 0, net: 12000, channel: 'cm.mtn', phone: '+237670000000', accountName: 'Awa Ngono' });
    expect(c.notifications.notifyStaff).toHaveBeenCalledWith('partners.manage', 'PARTNER_PAYOUT_REQUESTED_STAFF', { amount: 12000 });
  });
  it('déduit les retraits déjà demandés du solde', async () => {
    const c = ready({ earned: 12000, reserved: 8000 });
    await expect(c.service.requestPayout('u1')).rejects.toBeInstanceOf(BadRequestException);
    expect(c.tx.partnerPayout.create).not.toHaveBeenCalled();
  });
  it("exige l'identité vérifiée", async () => {
    const c = ready({ user: { kycStatus: 'NOT_SUBMITTED' } });
    await expect(c.service.requestPayout('u1')).rejects.toBeInstanceOf(BadRequestException);
  });
  it('exige un compte de paiement au nom du partenaire', async () => {
    const c = ready({ partner: { payoutAccountName: 'Paul Biya' } });
    await expect(c.service.requestPayout('u1')).rejects.toBeInstanceOf(BadRequestException);
  });
  it('bloque 72 h après un changement de compte', async () => {
    const c = ready({ partner: { payoutUpdatedAt: new Date() } });
    await expect(c.service.requestPayout('u1')).rejects.toBeInstanceOf(ConflictException);
  });
  it('refuse un partenaire suspendu', async () => {
    const c = ready({ partner: { status: 'SUSPENDED' } });
    await expect(c.service.requestPayout('u1')).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('refuse un second retrait tant que le premier est ouvert', async () => {
    const c = ready();
    c.tx.partnerPayout.findFirst.mockResolvedValue({ id: 'x' });
    await expect(c.service.requestPayout('u1')).rejects.toBeInstanceOf(ConflictException);
  });
  it('sépare la retenue à la source quand elle est fixée', async () => {
    const c = ready();
    c.prisma.partnerConfig.findUnique.mockResolvedValue({ ...CONFIG, withholdingPercent: 5 });
    await c.service.requestPayout('u1');
    expect(c.tx.partnerPayout.create.mock.calls[0]![0].data).toMatchObject({ gross: 12000, withholding: 600, net: 11400 });
  });
});

describe('PartnersService.setPayoutDetails', () => {
  it('refuse un compte au nom d\'un autre', async () => {
    const c = make();
    c.prisma.partnerProfile.findUnique.mockResolvedValue({ id: 'pa1' });
    c.prisma.user.findUnique.mockResolvedValue({ fullName: 'Awa Ngono' });
    await expect(c.service.setPayoutDetails('u1', { channel: 'cm.mtn', phone: '670000000', accountName: 'Paul Essomba' })).rejects.toBeInstanceOf(BadRequestException);
    expect(c.prisma.partnerProfile.update).not.toHaveBeenCalled();
  });
  it('enregistre un compte au bon nom, numéro normalisé', async () => {
    const c = make();
    c.prisma.partnerProfile.findUnique.mockResolvedValue({ id: 'pa1' });
    c.prisma.user.findUnique.mockResolvedValue({ fullName: 'Awa Ngono' });
    vi.spyOn(c.service, 'me').mockResolvedValue({} as never);
    await c.service.setPayoutDetails('u1', { channel: 'cm.orange', phone: '6 70 00 00 00', accountName: 'NGONO Awa' });
    expect(c.prisma.partnerProfile.update.mock.calls[0]![0].data).toMatchObject({ payoutChannel: 'cm.orange', payoutPhone: '+237670000000', payoutAccountName: 'NGONO Awa' });
  });
});

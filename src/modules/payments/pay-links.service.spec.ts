import { describe, expect, it, vi } from 'vitest';
import { PayLinksService } from './pay-links.service.js';

const TOKEN = 'a'.repeat(64);

function setup(over: Record<string, unknown> = {}) {
  const booking = {
    id: 'b1', travelerId: 't1', status: 'PENDING_PAYMENT', totalPrice: 100000, payToken: null,
    checkInDate: new Date('2099-01-10'), checkOutDate: new Date('2099-01-12'),
    room: { name: 'Chambre 1', property: { title: 'Villa Kribi', city: 'Kribi' } },
    traveler: { fullName: 'Marie Ngo' },
    ...over,
  };
  const prisma = {
    booking: { findUnique: vi.fn().mockResolvedValue(booking), update: vi.fn() },
  };
  const payments = {
    quote: vi.fn().mockResolvedValue({ kind: 'FULL', amount: 103000 }),
    startPayment: vi.fn().mockResolvedValue({ paymentUrl: 'https://pay', stage: 'FULL', amount: 103000 }),
    verifyBooking: vi.fn().mockResolvedValue({ confirmed: true }),
  };
  return { service: new PayLinksService(prisma as never, payments as never), prisma, payments };
}

describe('lien de paiement pour un proche', () => {
  it('crée un jeton de 64 caractères hexadécimaux et le garde', async () => {
    const { service, prisma } = setup();
    const { token } = await service.create('b1', 't1');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(prisma.booking.update).toHaveBeenCalledWith({ where: { id: 'b1' }, data: { payToken: token } });
  });

  it('renvoie le lien existant sans en créer un nouveau', async () => {
    const { service, prisma } = setup({ payToken: TOKEN });
    expect((await service.create('b1', 't1')).token).toBe(TOKEN);
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  it('refuse à un autre utilisateur, ou si rien n’est à payer', async () => {
    await expect(setup().service.create('b1', 'autre')).rejects.toThrow(/introuvable/);
    await expect(setup({ status: 'CONFIRMED_ESCROW' }).service.create('b1', 't1')).rejects.toThrow(/n'attend pas/);
  });

  it('révoque le lien', async () => {
    const { service, prisma } = setup({ payToken: TOKEN });
    await service.revoke('b1', 't1');
    expect(prisma.booking.update).toHaveBeenCalledWith({ where: { id: 'b1' }, data: { payToken: null } });
    await expect(setup().service.revoke('b1', 'autre')).rejects.toThrow(/introuvable/);
  });

  it('le résumé public ne montre que le nécessaire', async () => {
    const { service } = setup({ payToken: TOKEN });
    const s = await service.summary(TOKEN);
    expect(s).toEqual({
      propertyTitle: 'Villa Kribi', city: 'Kribi', roomName: 'Chambre 1',
      checkInDate: new Date('2099-01-10'), checkOutDate: new Date('2099-01-12'),
      travelerFirstName: 'Marie', status: 'PENDING_PAYMENT', payable: true, stage: 'FULL', amount: 103000, currency: 'XAF',
    });
  });

  it('refuse un jeton mal formé ou inconnu, et une réservation annulée', async () => {
    await expect(setup().service.summary('court')).rejects.toThrow(/invalide/);
    const none = setup();
    none.prisma.booking.findUnique.mockResolvedValue(null);
    await expect(none.service.summary(TOKEN)).rejects.toThrow(/invalide/);
    await expect(setup({ status: 'CANCELLED', payToken: TOKEN }).service.summary(TOKEN)).rejects.toThrow(/annulée/);
  });

  it('paie au nom du proche et ramène sur la page du lien', async () => {
    const { service, payments } = setup({ payToken: TOKEN });
    await service.initiate(TOKEN, { payerName: ' Paul ', payerEmail: 'Paul@Mail.FR', payerPhone: '+33 6 12 34 56 78' });
    expect(payments.startPayment).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'b1' }),
      { name: 'Paul', email: 'paul@mail.fr', phone: '+33612345678' },
      `/payer/${TOKEN}`,
    );
  });

  it('vérifie le retour du paiement via le jeton', async () => {
    const { service, payments } = setup({ payToken: TOKEN });
    expect(await service.verify(TOKEN, 'trx.1')).toEqual({ confirmed: true });
    expect(payments.verifyBooking).toHaveBeenCalledWith(expect.objectContaining({ id: 'b1' }), 'trx.1');
  });
});

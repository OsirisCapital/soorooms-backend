import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import type { PaymentsService } from '../payments/payments.service.js';
import { BookingsService } from './bookings.service.js';
import { countNights, receiptReference } from './receipt.js';

function setup(over: Record<string, unknown> = {}) {
  const booking = {
    id: '3f9a1c2b-0000-4000-8000-000000000000',
    travelerId: 't1',
    traveler: { fullName: 'Marie Ngo' },
    guestName: 'Paul Ngo',
    currency: 'XAF',
    checkInDate: new Date('2027-01-10'),
    checkOutDate: new Date('2027-01-13'),
    room: { name: 'Chambre 1', property: { title: 'Villa Kribi', city: 'Kribi', quarter: 'Mpalla' } },
    escrowVault: {
      travelerFee: 900,
      travelerFeePercent: 3,
      status: 'HELD_IN_ESCROW',
      transactions: [{ amount: 30900, paymentMethod: 'MTN_MOMO', createdAt: new Date('2026-10-12') }],
    },
    ...over,
  };
  const prisma = { booking: { findUnique: vi.fn().mockResolvedValue(booking), updateMany: vi.fn().mockResolvedValue({ count: 1 }) } };
  const service = new BookingsService(prisma as unknown as PrismaService, {} as PaymentsService, {} as NotificationsService);
  // `prisma` est privé dans le service : on l'expose sous un autre type pour piloter les mocks.
  return service as unknown as { getReceipt: BookingsService['getReceipt']; issueInvoice: BookingsService['issueInvoice']; prisma: typeof prisma };
}

describe('reçu voyageur', () => {
  it('référence stable et nuits', () => {
    expect(receiptReference('3f9a1c2b-0000-4000-8000-000000000000')).toBe('SR-3F9A1C2B');
    expect(countNights(new Date('2027-01-10'), new Date('2027-01-13'))).toBe(3);
  });

  it('sépare le prix du séjour et les frais de service', async () => {
    const r = await setup().getReceipt('b', 't1');
    expect(r).toMatchObject({ reference: 'SR-3F9A1C2B', stayPrice: 30000, travelerFee: 900, totalPaid: 30900, nights: 3, refunded: false, guestName: 'Paul Ngo', currency: 'XAF' });
  });

  it('refuse un autre utilisateur et une réservation non payée', async () => {
    await expect(setup().getReceipt('b', 'autre')).rejects.toThrow(/introuvable/);
    await expect(setup({ escrowVault: null }).getReceipt('b', 't1')).rejects.toThrow(/une fois le paiement/);
  });
});

describe('facture entreprise', () => {
  const dto = { company: 'ACME SARL', address: 'Rue 1, Douala', taxId: 'M012345678901A' };

  it("l'émet une fois après paiement", async () => {
    const svc = setup();
    await svc.issueInvoice('b', 't1', dto);
    expect(svc.prisma.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ invoiceIssuedAt: null }) }),
    );
  });

  it('refuse une deuxième émission', async () => {
    const issued = { invoiceCompany: 'X', invoiceAddress: 'Y', invoiceTaxId: null, invoiceIssuedAt: new Date() };
    await expect(setup(issued).issueInvoice('b', 't1', dto)).rejects.toThrow(/déjà émise/);
  });

  it('refuse en cas de course (aucune ligne mise à jour)', async () => {
    const svc = setup();
    svc.prisma.booking.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.issueInvoice('b', 't1', dto)).rejects.toThrow(/déjà émise/);
  });

  it('refuse un autre utilisateur ou un séjour non payé', async () => {
    await expect(setup().issueInvoice('b', 'autre', dto)).rejects.toThrow(/introuvable/);
    await expect(setup({ escrowVault: null }).issueInvoice('b', 't1', dto)).rejects.toThrow(/une fois le paiement/);
  });

  it('expose le bloc facture dans le reçu', async () => {
    const r = await setup({ invoiceCompany: 'ACME', invoiceAddress: 'Douala', invoiceTaxId: null, invoiceIssuedAt: new Date('2026-10-12') }).getReceipt('b', 't1');
    expect(r.invoice).toMatchObject({ number: 'FA-3F9A1C2B', company: 'ACME', taxId: null });
  });
});

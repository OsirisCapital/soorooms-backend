import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import type { PaymentsService } from '../payments/payments.service.js';
import { BookingsService } from './bookings.service.js';

const TRAVELER = 'traveler-1';
const HOST_A = 'host-a';
const HOST_B = 'host-b';

function context(over: Record<string, unknown> = {}) {
  return {
    id: 'b1',
    roomId: 'room-1',
    travelerId: TRAVELER,
    status: 'NEGOTIATING',
    checkInDate: new Date('2027-01-10'),
    checkOutDate: new Date('2027-01-12'),
    travelerConfirmedAt: null,
    hostConfirmedAt: null,
    room: { name: 'Chambre', basePrice: 15000, property: { title: 'Villa Kribi', status: 'ACTIVE', collaborators: [{ userId: HOST_A }, { userId: HOST_B }] } },
    offers: [{ id: 'o1', proposedByUserId: TRAVELER, amount: 30000 }],
    ...over,
  };
}

function make(booking = context(), opts: { releasedCount?: number; later?: Record<string, unknown> } = {}) {
  const tx = {
    $queryRaw: vi.fn(),
    booking: { findFirst: vi.fn().mockResolvedValue(null), updateMany: vi.fn().mockResolvedValue({ count: 1 }), update: vi.fn(), create: vi.fn().mockResolvedValue({ id: 'b1' }) },
    priceOffer: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), update: vi.fn(), create: vi.fn() },
  };
  const prisma = {
    booking: {
      findUnique: vi.fn().mockImplementation(async () => booking),
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: opts.releasedCount ?? 1 }),
    },
    room: { findUnique: vi.fn().mockResolvedValue({ id: 'room-1', basePrice: 15000, property: booking.room.property }) },
    user: { findUnique: vi.fn().mockResolvedValue({ fullName: 'Marie Ngo' }) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const payments = { releaseEscrow: vi.fn().mockResolvedValue({ hostPayout: 27000 }) };
  const notifications = { notify: vi.fn().mockResolvedValue(true), notifyMany: vi.fn().mockResolvedValue(undefined), notifyStaff: vi.fn().mockResolvedValue(undefined) };
  const service = new BookingsService(prisma as unknown as PrismaService, payments as unknown as PaymentsService, notifications as unknown as NotificationsService);
  return { service, prisma, tx, payments, notifications };
}

describe('BookingsService — notifications', () => {
  it("à la création, prévient tous les gestionnaires du logement, avec le prix proposé", async () => {
    const { service, notifications } = make();
    await service.create(TRAVELER, { roomId: 'room-1', checkInDate: '2099-01-10', checkOutDate: '2099-01-12', proposedPrice: 28000 } as never);
    expect(notifications.notifyMany).toHaveBeenCalledWith([HOST_A, HOST_B], 'BOOKING_REQUESTED', {
      bookingId: 'b1',
      travelerName: 'Marie Ngo',
      propertyTitle: 'Villa Kribi',
      amount: 28000,
    });
  });

  it("une contre-offre de l'hôte prévient le voyageur, pas l'hôte lui-même", async () => {
    const { service, notifications } = make();
    await service.counterOffer('b1', HOST_A, { amount: 35000 } as never);
    expect(notifications.notify).toHaveBeenCalledTimes(2); // le voyageur + l'autre gestionnaire
    expect(notifications.notify).toHaveBeenCalledWith(TRAVELER, 'OFFER_RECEIVED', expect.objectContaining({ audience: 'traveler', amount: 35000 }));
    expect(notifications.notify).toHaveBeenCalledWith(HOST_B, 'OFFER_RECEIVED', expect.objectContaining({ audience: 'host' }));
    expect(notifications.notify).not.toHaveBeenCalledWith(HOST_A, expect.anything(), expect.anything());
  });

  it("l'acceptation par l'hôte prévient le voyageur avec le prix retenu", async () => {
    const { service, notifications } = make();
    await service.acceptOffer('b1', HOST_A);
    expect(notifications.notify).toHaveBeenCalledWith(TRAVELER, 'OFFER_ACCEPTED', { bookingId: 'b1', audience: 'traveler', amount: 30000, propertyTitle: 'Villa Kribi' });
    expect(notifications.notify).not.toHaveBeenCalledWith(HOST_A, expect.anything(), expect.anything());
  });

  it("n'envoie aucune notification quand l'acceptation échoue (offre dépassée)", async () => {
    const { service, tx, notifications } = make();
    tx.priceOffer.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.acceptOffer('b1', HOST_A)).rejects.toThrow();
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it("un refus prévient l'autre partie que la réservation est annulée", async () => {
    const { service, notifications } = make();
    await service.rejectOffer('b1', HOST_A);
    expect(notifications.notify).toHaveBeenCalledWith(TRAVELER, 'OFFER_REJECTED', { bookingId: 'b1', audience: 'traveler', propertyTitle: 'Villa Kribi' });
  });

  it("l'arrivée du voyageur demande la confirmation des hôtes, une seule fois", async () => {
    const paid = context({ status: 'CONFIRMED_ESCROW' });
    const first = make(paid);
    // après la mise à jour, l'hôte n'a toujours pas confirmé
    await first.service.confirmCheckin('b1', TRAVELER);
    expect(first.notifications.notifyMany).toHaveBeenCalledWith([HOST_A, HOST_B], 'STAY_CONFIRMATION_REQUESTED', expect.objectContaining({ audience: 'host', otherName: 'Marie Ngo' }));

    const again = make(context({ status: 'CONFIRMED_ESCROW', travelerConfirmedAt: new Date() }));
    await again.service.confirmCheckin('b1', TRAVELER);
    expect(again.notifications.notifyMany).not.toHaveBeenCalled();
  });

  it("quand les deux ont confirmé : séjour terminé pour le voyageur, versement mis en file (l'hôte est prévenu par PayoutsService)", async () => {
    const both = context({ status: 'CONFIRMED_ESCROW', hostConfirmedAt: new Date(), travelerConfirmedAt: new Date() });
    const { service, notifications, payments } = make(both);
    await service.confirmCheckin('b1', TRAVELER);
    expect(payments.releaseEscrow).toHaveBeenCalledWith('b1');
    expect(notifications.notify).toHaveBeenCalledWith(TRAVELER, 'BOOKING_COMPLETED', { bookingId: 'b1', propertyTitle: 'Villa Kribi' });
    expect(notifications.notifyMany).not.toHaveBeenCalledWith(expect.anything(), 'PAYOUT_RELEASED', expect.anything());
  });

  it("ne dit pas « versement » si la réservation était déjà terminée par un autre appel", async () => {
    const both = context({ status: 'CONFIRMED_ESCROW', hostConfirmedAt: new Date(), travelerConfirmedAt: new Date() });
    const { service, notifications } = make(both, { releasedCount: 0 });
    await service.confirmCheckin('b1', TRAVELER);
    expect(notifications.notifyMany).not.toHaveBeenCalledWith(expect.anything(), 'PAYOUT_RELEASED', expect.anything());
    expect(notifications.notify).not.toHaveBeenCalledWith(expect.anything(), 'BOOKING_COMPLETED', expect.anything());
  });

  it("ne dit pas « versement » si le reversement échoue", async () => {
    const both = context({ status: 'CONFIRMED_ESCROW', hostConfirmedAt: new Date(), travelerConfirmedAt: new Date() });
    const { service, notifications, payments } = make(both);
    payments.releaseEscrow.mockRejectedValue(new Error('agrégateur indisponible'));
    await expect(service.confirmCheckin('b1', TRAVELER)).rejects.toThrow('agrégateur indisponible');
    expect(notifications.notifyMany).not.toHaveBeenCalledWith(expect.anything(), 'PAYOUT_RELEASED', expect.anything());
  });

  it("l'hôte qui confirme en premier demande sa confirmation au voyageur", async () => {
    const { service, notifications } = make(context({ status: 'CONFIRMED_ESCROW' }));
    await service.confirmHosting('b1', HOST_A);
    expect(notifications.notify).toHaveBeenCalledWith(TRAVELER, 'STAY_CONFIRMATION_REQUESTED', expect.objectContaining({ audience: 'traveler' }));
  });

  it("un litige prévient l'autre partie ET l'équipe qui a l'accès « disputes.view »", async () => {
    const { service, notifications } = make(context({ status: 'CONFIRMED_ESCROW' }));
    await service.raiseDispute('b1', TRAVELER, { reason: 'Logement non conforme' } as never);
    expect(notifications.notify).toHaveBeenCalledWith(HOST_A, 'DISPUTE_OPENED', { bookingId: 'b1', audience: 'host' });
    expect(notifications.notify).toHaveBeenCalledWith(HOST_B, 'DISPUTE_OPENED', { bookingId: 'b1', audience: 'host' });
    expect(notifications.notify).not.toHaveBeenCalledWith(TRAVELER, expect.anything(), expect.anything());
    expect(notifications.notifyStaff).toHaveBeenCalledWith('disputes.view', 'DISPUTE_OPENED_STAFF', { bookingId: 'b1' });
  });
});

import { describe, expect, it } from 'vitest';
import { bookingLink, clip, fcfa, isInternalPath, renderNotification, ticketRef, type NotificationPayloads, type NotificationType } from './notification-types.js';

describe('fcfa', () => {
  it('sépare les milliers par une espace ordinaire', () => {
    expect(fcfa(15000)).toBe('15 000 FCFA');
    expect(fcfa(2450000)).toBe('2 450 000 FCFA');
    expect(fcfa(950)).toBe('950 FCFA');
    expect(fcfa(1234.6)).toBe('1 235 FCFA');
  });
});

describe('clip', () => {
  it('met sur une ligne et borne le texte saisi par un utilisateur', () => {
    expect(clip('  Jean \n  Kouamé ')).toBe('Jean Kouamé');
    const long = clip('a'.repeat(200), 20);
    expect(long).toHaveLength(20);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('isInternalPath', () => {
  it('accepte un chemin interne et refuse tout ce qui sort de l\'application', () => {
    expect(isInternalPath('/hote/reservations/abc')).toBe(true);
    for (const bad of ['https://evil.test', '//evil.test', '/\\evil.test', 'javascript:alert(1)', '', undefined, 42, `/${'a'.repeat(300)}`]) {
      expect(isInternalPath(bad)).toBe(false);
    }
  });
});

describe('ticketRef', () => {
  it('donne un numéro lisible sur 4 chiffres au minimum', () => {
    expect(ticketRef(42)).toBe('SR-0042');
    expect(ticketRef(12345)).toBe('SR-12345');
  });
});

describe('bookingLink', () => {
  it("mène l'hôte et le voyageur à leur propre page de réservation", () => {
    expect(bookingLink('host', 'b1')).toBe('/hote/reservations/b1');
    expect(bookingLink('traveler', 'b1')).toBe('/profil/reservations/b1');
  });
});

describe('renderNotification', () => {
  it('annonce le prix proposé et mène à la bonne page selon le destinataire', () => {
    const toHost = renderNotification('OFFER_RECEIVED', { bookingId: 'b1', audience: 'host', amount: 30000, fromName: 'Marie' });
    expect(toHost.body).toContain('30 000 FCFA');
    expect(toHost.body).toContain('Marie');
    expect(toHost.linkUrl).toBe('/hote/reservations/b1');
    expect(renderNotification('OFFER_RECEIVED', { bookingId: 'b1', audience: 'traveler', amount: 1, fromName: 'H' }).linkUrl).toBe('/profil/reservations/b1');
  });

  it("n'écrit pas le même texte au voyageur et à l'hôte pour un paiement", () => {
    const base = { bookingId: 'b1', amount: 45000, propertyTitle: 'Villa' };
    const traveler = renderNotification('PAYMENT_CONFIRMED', { ...base, audience: 'traveler' });
    const host = renderNotification('PAYMENT_CONFIRMED', { ...base, audience: 'host' });
    expect(traveler.body).not.toBe(host.body);
    expect(traveler.linkUrl).toBe('/profil/reservations/b1');
    expect(host.linkUrl).toBe('/hote/reservations/b1');
  });

  it("la demande de réservation annonce le prix proposé quand il est connu", () => {
    const base = { bookingId: 'b', travelerName: 'Marie', propertyTitle: 'Villa' };
    expect(renderNotification('BOOKING_REQUESTED', { ...base, amount: 28000 }).body).toContain('28 000 FCFA');
    expect(renderNotification('BOOKING_REQUESTED', base).body).not.toContain('FCFA');
  });

  it('une annonce ne peut mener que vers une page de l\'application', () => {
    expect(renderNotification('ANNOUNCEMENT', { title: 'T', body: 'B', href: 'https://evil.test' }).linkUrl).toBeNull();
    expect(renderNotification('ANNOUNCEMENT', { title: 'T', body: 'B', href: '/home' }).linkUrl).toBe('/home');
  });

  it("borne un nom ou un titre saisi par l'utilisateur", () => {
    const { body } = renderNotification('BOOKING_REQUESTED', { bookingId: 'b', travelerName: 'x'.repeat(500), propertyTitle: 'y'.repeat(500) });
    expect(body.length).toBeLessThan(250);
  });

  it('chaque type du catalogue produit un titre, un texte et un lien interne (ou aucun)', () => {
    const samples: { [K in NotificationType]: NotificationPayloads[K] } = {
      KYC_SUBMITTED: { fullName: 'A' },
      KYC_APPROVED: {},
      KYC_REJECTED: { reason: 'flou' },
      BOOKING_REQUESTED: { bookingId: 'b', travelerName: 'A', propertyTitle: 'P' },
      OFFER_RECEIVED: { bookingId: 'b', audience: 'host', amount: 1, fromName: 'A' },
      OFFER_ACCEPTED: { bookingId: 'b', audience: 'traveler', amount: 1, propertyTitle: 'P' },
      OFFER_REJECTED: { bookingId: 'b', audience: 'host', propertyTitle: 'P' },
      PAYMENT_CONFIRMED: { bookingId: 'b', audience: 'host', amount: 1, propertyTitle: 'P' },
      PAYMENT_FAILED: { bookingId: 'b', propertyTitle: 'P' },
      STAY_CONFIRMATION_REQUESTED: { bookingId: 'b', audience: 'host', otherName: 'A' },
      BOOKING_COMPLETED: { bookingId: 'b', propertyTitle: 'P' },
      PAYOUT_RELEASED: { bookingId: 'b', amount: 1, propertyTitle: 'P' },
      DISPUTE_OPENED: { bookingId: 'b', audience: 'traveler' },
      DISPUTE_OPENED_STAFF: { bookingId: 'b' },
      PROPERTY_PUBLISHED: { propertyId: 'p', propertyTitle: 'P' },
      PROPERTY_SUSPENDED: { propertyId: 'p', propertyTitle: 'P' },
      SUPPORT_TICKET_NEW: { ticketId: 't', number: 42, subject: 'Aide' },
      SUPPORT_USER_REPLY: { ticketId: 't', number: 42, fromName: 'A' },
      SUPPORT_REPLY: { ticketId: 't', number: 42 },
      SUPPORT_TICKET_RESOLVED: { ticketId: 't', number: 42 },
      MESSAGE_RECEIVED: { fromName: 'A' },
      ANNOUNCEMENT: { title: 'T', body: 'B' },
    };
    for (const type of Object.keys(samples) as NotificationType[]) {
      const out = renderNotification(type, samples[type] as never);
      expect(out.title.length, type).toBeGreaterThan(0);
      expect(out.body.length, type).toBeGreaterThan(0);
      if (out.linkUrl !== null) expect(isInternalPath(out.linkUrl), type).toBe(true);
    }
  });
});

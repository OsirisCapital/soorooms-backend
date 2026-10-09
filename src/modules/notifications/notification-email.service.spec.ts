import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { MailService } from '../mail/mail.service.js';
import { notificationEmail } from '../mail/notification-email.template.js';
import { EMAIL_NOTIFICATION_TYPES, NotificationEmailService } from './notification-email.service.js';
import { renderNotification } from './notification-types.js';

function make() {
  const findMany = vi.fn().mockResolvedValue([{ email: 'a@b.cm', fullName: 'Awa Ngono' }]);
  const send = vi.fn().mockResolvedValue(true);
  const config = { get: vi.fn().mockReturnValue('https://soorooms.vercel.app') };
  const service = new NotificationEmailService(
    { user: { findMany } } as unknown as PrismaService,
    { send } as unknown as MailService,
    config as unknown as ConfigService<never, true>,
  );
  return { service, findMany, send };
}

const rendered = { title: 'Paiement reçu ✓', body: 'Votre paiement est confirmé.', linkUrl: '/profil/reservations/b1' };

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

describe('NotificationEmailService.sendFor', () => {
  it("n'écrit qu'aux adresses vérifiées de personnes qui n'ont pas désactivé les e-mails", async () => {
    const { service, findMany } = make();
    await service.sendFor(['u1'], 'PAYMENT_CONFIRMED', rendered);
    expect(findMany).toHaveBeenCalledWith({
      where: { id: { in: ['u1'] }, email: { not: null }, emailVerifiedAt: { not: null }, emailNotifications: true },
      select: { email: true, fullName: true },
    });
  });

  it("envoie un e-mail dont le bouton mène à la page de l'application", async () => {
    const { service, send } = make();
    await service.sendFor(['u1'], 'PAYMENT_CONFIRMED', rendered);
    const message = send.mock.calls[0][0];
    expect(message.to).toEqual({ email: 'a@b.cm', name: 'Awa Ngono' });
    expect(message.subject).toBe('Paiement reçu ✓ — SòôRooms');
    expect(message.html).toContain('https://soorooms.vercel.app/profil/reservations/b1');
    expect(message.text).toContain('https://soorooms.vercel.app/profil/reservations/b1');
  });

  it("un lien non interne est remplacé par la page des notifications", async () => {
    const { service, send } = make();
    await service.sendFor(['u1'], 'PAYMENT_CONFIRMED', { ...rendered, linkUrl: 'https://pirate.example' });
    expect(send.mock.calls[0][0].html).toContain('https://soorooms.vercel.app/notifications');
    expect(send.mock.calls[0][0].html).not.toContain('pirate');
  });

  it("ignore les événements qui ne méritent pas d'e-mail, sans même interroger la base", async () => {
    const { service, findMany, send } = make();
    await service.sendFor(['u1'], 'SUPPORT_TICKET_NEW', rendered);
    await service.sendFor(['u1'], 'ANNOUNCEMENT', rendered);
    await service.sendFor(['u1'], 'TASK_ASSIGNED', rendered);
    expect(findMany).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("ne fait rien sans destinataire", async () => {
    const { service, findMany } = make();
    await service.sendFor([], 'PAYMENT_CONFIRMED', rendered);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("ne lève jamais d'erreur, même si la base ou Brevo échouent", async () => {
    const a = make();
    a.findMany.mockRejectedValue(new Error('base'));
    await expect(a.service.sendFor(['u1'], 'PAYMENT_CONFIRMED', rendered)).resolves.toBeUndefined();
    const b = make();
    b.send.mockRejectedValue(new Error('réseau'));
    await expect(b.service.sendFor(['u1'], 'PAYMENT_CONFIRMED', rendered)).resolves.toBeUndefined();
  });

  it("les alertes internes de l'équipe ne partent jamais par e-mail", () => {
    for (const type of ['KYC_SUBMITTED', 'DISPUTE_OPENED_STAFF', 'SUPPORT_TICKET_NEW', 'SUPPORT_USER_REPLY', 'TASK_DONE', 'TASK_ASSIGNED', 'ANNOUNCEMENT'] as const) {
      expect(EMAIL_NOTIFICATION_TYPES.has(type)).toBe(false);
    }
  });

  it('chaque type retenu existe dans le catalogue et se rend sans erreur', () => {
    const samples = {
      KYC_APPROVED: {}, KYC_REJECTED: { reason: 'x' }, BOOKING_REQUESTED: { bookingId: 'b', travelerName: 'T', propertyTitle: 'P' },
      OFFER_RECEIVED: { bookingId: 'b', audience: 'host', amount: 1, fromName: 'F' }, OFFER_ACCEPTED: { bookingId: 'b', audience: 'host', amount: 1, propertyTitle: 'P' },
      OFFER_REJECTED: { bookingId: 'b', audience: 'host', propertyTitle: 'P' }, PAYMENT_CONFIRMED: { bookingId: 'b', audience: 'host', amount: 1, propertyTitle: 'P' },
      PAYMENT_FAILED: { bookingId: 'b', propertyTitle: 'P' }, STAY_CONFIRMATION_REQUESTED: { bookingId: 'b', audience: 'host', otherName: 'O' },
      BOOKING_COMPLETED: { bookingId: 'b', propertyTitle: 'P' }, PAYOUT_RELEASED: { bookingId: 'b', amount: 1, propertyTitle: 'P' },
      DISPUTE_OPENED: { bookingId: 'b', audience: 'host' }, PROPERTY_PUBLISHED: { propertyId: 'p', propertyTitle: 'P' },
      PROPERTY_SUSPENDED: { propertyId: 'p', propertyTitle: 'P' }, SUPPORT_REPLY: { ticketId: 't', number: 1 },
      SUPPORT_TICKET_RESOLVED: { ticketId: 't', number: 1 }, STAFF_ACCESS_CHANGED: { roleLabel: null }, MESSAGE_RECEIVED: { fromName: 'F' },
    } as const;
    expect(Object.keys(samples).sort()).toEqual([...EMAIL_NOTIFICATION_TYPES].sort());
    for (const [type, payload] of Object.entries(samples)) {
      const r = renderNotification(type as keyof typeof samples, payload as never);
      expect(r.title.length).toBeGreaterThan(0);
    }
  });
});

describe('notificationEmail (gabarit)', () => {
  const base = { fullName: 'Awa Ngono', title: 'Titre', body: 'Texte', url: 'https://x.cm/a', settingsUrl: 'https://x.cm/notifications' };

  it('échappe tout ce qui vient d\'un utilisateur', () => {
    const mail = notificationEmail({ ...base, fullName: '<script>alert(1)</script> Bob', body: 'Jean <b>"dit"</b> & co' });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).not.toContain('<b>');
    expect(mail.html).toContain('&lt;b&gt;');
    expect(mail.html).toContain('&amp; co');
  });

  it("garde l'objet sur une seule ligne et propose de gérer les notifications", () => {
    const mail = notificationEmail({ ...base, title: 'Ligne 1\nLigne 2\r\nInjection: Bcc: x@y.z' });
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.html).toContain('https://x.cm/notifications');
    expect(mail.text).toContain('https://x.cm/notifications');
  });

  it('se passe du prénom si le nom est vide', () => {
    expect(notificationEmail({ ...base, fullName: '  ' }).text.startsWith('Bonjour,')).toBe(true);
  });
});

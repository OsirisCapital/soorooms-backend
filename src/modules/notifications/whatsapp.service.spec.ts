import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { NotificationWhatsappService, WHATSAPP_NOTIFICATION_TYPES } from './notification-whatsapp.service.js';
import { templateParam, toWhatsappNumber, WhatsAppService } from './whatsapp.service.js';

const cfg = { accessToken: 'tok', phoneNumberId: '123', templateName: 'soorooms_notification', templateLanguage: 'fr', apiVersion: 'v21.0' };
const config = (whatsapp = cfg) => ({ get: vi.fn((key: string) => (key === 'whatsapp' ? whatsapp : key === 'frontendUrl' ? 'https://soorooms.com' : 'production')) }) as unknown as ConfigService<never, true>;

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe('toWhatsappNumber', () => {
  it('retire le + et refuse les numéros factices des comptes Google', () => {
    expect(toWhatsappNumber('+237670000000')).toBe('237670000000');
    expect(toWhatsappNumber('google:1234')).toBeNull();
    expect(toWhatsappNumber('670000000')).toBeNull();
    expect(toWhatsappNumber(null)).toBeNull();
  });
});

describe('templateParam', () => {
  it('met sur une ligne et borne le texte (règles de Meta)', () => {
    expect(templateParam('a\nb\t c    d')).toBe('a b c d');
    expect(templateParam('x'.repeat(2000), 50)).toHaveLength(50);
  });
});

describe('WhatsAppService.send', () => {
  it("n'envoie rien (et ne lève pas) quand WhatsApp n'est pas configuré", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const service = new WhatsAppService(config({ ...cfg, accessToken: '' }));
    expect(service.enabled).toBe(false);
    expect(await service.send({ to: '237670000000', firstName: 'A', message: 'm', url: 'u' })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('appelle Meta avec le modèle et les trois variables', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const service = new WhatsAppService(config());
    expect(await service.send({ to: '237670000000', firstName: 'Awa', message: 'Paiement reçu', url: 'https://soorooms.com/x' })).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://graph.facebook.com/v21.0/123/messages');
    expect(init.headers.Authorization).toBe('Bearer tok');
    const body = JSON.parse(init.body);
    expect(body.to).toBe('237670000000');
    expect(body.template.name).toBe('soorooms_notification');
    expect(body.template.components[0].parameters.map((p: { text: string }) => p.text)).toEqual(['Awa', 'Paiement reçu', 'https://soorooms.com/x']);
  });

  it('renvoie false si Meta refuse ou ne répond pas', async () => {
    const service = new WhatsAppService(config());
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'bad' }));
    expect(await service.send({ to: '1', firstName: 'A', message: 'm', url: 'u' })).toBe(false);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    expect(await service.send({ to: '1', firstName: 'A', message: 'm', url: 'u' })).toBe(false);
  });
});

describe('NotificationWhatsappService.sendFor', () => {
  function make(users: { phone: string; fullName: string }[]) {
    const findMany = vi.fn().mockResolvedValue(users);
    const send = vi.fn().mockResolvedValue(true);
    const service = new NotificationWhatsappService({ user: { findMany } } as unknown as PrismaService, { enabled: true, send } as unknown as WhatsAppService, config());
    return { service, findMany, send };
  }
  const rendered = { title: 'Paiement reçu ✓', body: 'Votre paiement est confirmé.', linkUrl: '/profil/reservations/b1' };

  it("n'écrit qu'aux personnes qui n'ont pas désactivé WhatsApp, avec un vrai numéro", async () => {
    const { service, findMany, send } = make([
      { phone: '+237670000000', fullName: 'Awa Ngono' },
      { phone: 'google:99', fullName: 'Paul' },
    ]);
    await service.sendFor(['u1', 'u2'], 'PAYMENT_CONFIRMED', rendered);
    expect(findMany).toHaveBeenCalledWith({ where: { id: { in: ['u1', 'u2'] }, whatsappNotifications: true }, select: { phone: true, fullName: true } });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ to: '237670000000', firstName: 'Awa', message: 'Paiement reçu ✓ — Votre paiement est confirmé.', url: 'https://soorooms.com/profil/reservations/b1' });
  });

  it("ignore les types qui ne méritent pas un message et les alertes de l'équipe", async () => {
    const { service, findMany } = make([]);
    await service.sendFor(['u1'], 'SUPPORT_TICKET_NEW', rendered);
    await service.sendFor(['u1'], 'TASK_ASSIGNED', rendered);
    expect(findMany).not.toHaveBeenCalled();
    expect(WHATSAPP_NOTIFICATION_TYPES.has('ARRIVAL_REMINDER')).toBe(true);
    expect(WHATSAPP_NOTIFICATION_TYPES.has('PAYOUT_FAILED_STAFF')).toBe(false);
  });

  it('ne lève jamais d\'erreur', async () => {
    const { service, findMany } = make([]);
    findMany.mockRejectedValue(new Error('db'));
    await expect(service.sendFor(['u1'], 'PAYMENT_CONFIRMED', rendered)).resolves.toBeUndefined();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailService } from './mail.service.js';

function makeService(mail: Partial<{ brevoApiKey: string; fromEmail: string; fromName: string }> = {}, nodeEnv = 'production') {
  const values: Record<string, unknown> = {
    mail: { brevoApiKey: 'xkeysib-test', fromEmail: 'no-reply@soorooms.com', fromName: 'SòôRooms', ...mail },
    nodeEnv,
  };
  return new MailService({ get: (key: string) => values[key] } as never);
}

const message = {
  to: { email: 'aline@example.com', name: 'Aline K.' },
  subject: 'Sujet',
  html: '<p>Bonjour</p>',
  text: 'Bonjour LIEN-SECRET-123',
};

describe('MailService', () => {
  const fetchMock = vi.fn();
  beforeEach(() => vi.stubGlobal('fetch', fetchMock));
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('envoie à Brevo avec la clé dans l’en-tête api-key et le bon format', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ messageId: '<1@brevo>' }), { status: 201 }));
    await expect(makeService().send(message)).resolves.toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(init.method).toBe('POST');
    expect(init.headers['api-key']).toBe('xkeysib-test');
    expect(JSON.parse(init.body)).toEqual({
      sender: { name: 'SòôRooms', email: 'no-reply@soorooms.com' },
      to: [{ email: 'aline@example.com', name: 'Aline K.' }],
      subject: 'Sujet',
      htmlContent: '<p>Bonjour</p>',
      textContent: 'Bonjour LIEN-SECRET-123',
    });
  });

  it('renvoie false (sans exception) quand Brevo refuse, par exemple un expéditeur non validé', async () => {
    fetchMock.mockResolvedValue(new Response('{"code":"invalid_parameter","message":"Sender not valid"}', { status: 400 }));
    await expect(makeService().send(message)).resolves.toBe(false);
  });

  it('renvoie false (sans exception) quand Brevo est injoignable', async () => {
    fetchMock.mockRejectedValue(new Error('fetch failed'));
    await expect(makeService().send(message)).resolves.toBe(false);
  });

  it('n’appelle pas Brevo sans clé ou sans adresse d’expédition', async () => {
    await expect(makeService({ brevoApiKey: '' }).send(message)).resolves.toBe(false);
    await expect(makeService({ fromEmail: '' }).send(message)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('n’écrit JAMAIS le contenu (donc les liens à usage unique) dans les journaux en production', async () => {
    const logs: string[] = [];
    const service = makeService({ brevoApiKey: '' }, 'production');
    const spy = vi.spyOn(service['logger'], 'error').mockImplementation((m: unknown) => void logs.push(String(m)));
    vi.spyOn(service['logger'], 'warn').mockImplementation((m: unknown) => void logs.push(String(m)));
    await service.send(message);
    expect(spy).toHaveBeenCalled();
    expect(logs.join('\n')).not.toContain('LIEN-SECRET-123');
  });

  it('affiche le contenu en développement pour pouvoir tester sans compte Brevo', async () => {
    const logs: string[] = [];
    const service = makeService({ brevoApiKey: '' }, 'development');
    vi.spyOn(service['logger'], 'warn').mockImplementation((m: unknown) => void logs.push(String(m)));
    await service.send(message);
    expect(logs.join('\n')).toContain('LIEN-SECRET-123');
  });
});

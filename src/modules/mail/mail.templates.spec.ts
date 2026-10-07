import { describe, expect, it } from 'vitest';
import { escapeHtml, passwordResetEmail, verificationEmail } from './mail.templates.js';

const URL = 'https://soorooms.vercel.app/verify-email?token=abc123';

describe('gabarits d’e-mail', () => {
  it('échappe le HTML d’un nom hostile', () => {
    const { html } = verificationEmail({ fullName: '<script>alert(1)</script> Mallory', url: URL });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('échappe les caractères spéciaux d’une adresse de lien', () => {
    const { html } = verificationEmail({ fullName: 'Aline', url: 'https://x.test/?a=1&b="2"' });
    expect(html).toContain('a=1&amp;b=&quot;2&quot;');
    expect(html).not.toContain('b="2"');
  });

  it('contient le lien dans le bouton, en clair, et dans la version texte', () => {
    const { html, text, subject } = verificationEmail({ fullName: 'Aline K.', url: URL });
    expect(subject).toMatch(/SòôRooms/);
    expect(html.split(URL).length - 1).toBeGreaterThanOrEqual(2); // bouton + lien affiché
    expect(text).toContain(URL);
    expect(text).toContain('Bonjour Aline,');
  });

  it('salue sans nom quand il est vide', () => {
    expect(verificationEmail({ fullName: '   ', url: URL }).text.startsWith('Bonjour,')).toBe(true);
  });

  it('indique la durée de validité du lien de réinitialisation', () => {
    const { text, html } = passwordResetEmail({ fullName: 'Aline', url: URL, validityMinutes: 30 });
    expect(text).toContain('30 minutes');
    expect(html).toContain('30 minutes');
  });

  it('escapeHtml neutralise les cinq caractères dangereux', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});

/**
 * Envoi d'e-mails transactionnels via l'API Brevo (POST /v3/smtp/email).
 *
 * `send` NE LÈVE JAMAIS d'exception : un e-mail qui ne part pas ne doit pas faire échouer une
 * inscription ou une demande de mot de passe. Il renvoie `true` si Brevo a accepté le message,
 * `false` sinon (l'appelant décide alors quoi répondre à l'utilisateur).
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';
const REQUEST_TIMEOUT_MS = 10_000;

export interface MailMessage {
  to: { email: string; name?: string };
  subject: string;
  html: string;
  text: string;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(private readonly configService: ConfigService<AppConfig, true>) {}

  async send(message: MailMessage): Promise<boolean> {
    const { brevoApiKey, fromEmail, fromName } = this.configService.get('mail', { infer: true });
    const isProduction = this.configService.get('nodeEnv', { infer: true }) === 'production';

    if (!brevoApiKey || !fromEmail) {
      if (isProduction) {
        // Jamais le contenu en production : il contient des liens à usage unique.
        this.logger.error('E-mail non envoyé : BREVO_API_KEY ou MAIL_FROM_EMAIL est absente.');
      } else {
        // En développement, afficher le message permet de tester sans compte Brevo.
        this.logger.warn(`E-mail non envoyé (Brevo non configuré). Contenu pour ${message.to.email} :\n${message.text}`);
      }
      return false;
    }

    try {
      const response = await fetch(BREVO_URL, {
        method: 'POST',
        headers: { 'api-key': brevoApiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          sender: { name: fromName, email: fromEmail },
          to: [message.to.name ? { email: message.to.email, name: message.to.name } : { email: message.to.email }],
          subject: message.subject,
          htmlContent: message.html,
          textContent: message.text,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        const body = (await response.text()).slice(0, 500);
        this.logger.error(`Brevo a refusé l'e-mail (${response.status}) : ${body}`);
        return false;
      }
      return true;
    } catch (error) {
      this.logger.error(`Brevo injoignable : ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
}

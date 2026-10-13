/**
 * Envoi de messages WhatsApp via l'API Cloud de Meta (POST /{phone-number-id}/messages).
 *
 * Hors fenêtre de 24 h, WhatsApp n'accepte que des MODÈLES approuvés par Meta. On en utilise un seul,
 * générique, à trois variables : le prénom, le message, le lien. Texte du modèle à faire approuver
 * (catégorie « Utilitaire », langue fr, nom `soorooms_notification`) :
 *
 *   Bonjour {{1}},
 *
 *   {{2}}
 *
 *   Pour le détail, ouvrez SòôRooms : {{3}}
 *
 *   L'équipe SòôRooms
 *
 * `send` NE LÈVE JAMAIS d'exception : un message qui ne part pas ne doit pas faire échouer un paiement.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';

const REQUEST_TIMEOUT_MS = 10_000;
/** Meta refuse les variables trop longues : on reste bien en dessous de sa limite. */
const MAX_PARAM = 900;

/** « +237670000000 » → « 237670000000 » (format attendu par Meta), ou null si ce n'est pas un vrai numéro. */
export function toWhatsappNumber(phone: string | null | undefined): string | null {
  if (!phone) return null;
  // Les comptes créés via Google ont un numéro factice « google:<id> » : jamais de message.
  return /^\+\d{8,15}$/.test(phone) ? phone.slice(1) : null;
}

/** Meta interdit retours à la ligne, tabulations et séries de 4 espaces dans une variable de modèle. */
export function templateParam(text: string, max = MAX_PARAM): string {
  const flat = text.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  get enabled(): boolean {
    const { accessToken, phoneNumberId } = this.config.get('whatsapp', { infer: true });
    return Boolean(accessToken && phoneNumberId);
  }

  /** Renvoie true si Meta a accepté le message. */
  async send(input: { to: string; firstName: string; message: string; url: string }): Promise<boolean> {
    const cfg = this.config.get('whatsapp', { infer: true });
    if (!cfg.accessToken || !cfg.phoneNumberId) {
      if (this.config.get('nodeEnv', { infer: true }) !== 'production') {
        this.logger.warn(`WhatsApp non envoyé (non configuré) à ${input.to} : ${input.message}`);
      }
      return false;
    }
    try {
      const response = await fetch(`https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: input.to,
          type: 'template',
          template: {
            name: cfg.templateName,
            language: { code: cfg.templateLanguage },
            components: [
              {
                type: 'body',
                parameters: [
                  { type: 'text', text: templateParam(input.firstName, 60) || 'là' },
                  { type: 'text', text: templateParam(input.message) },
                  { type: 'text', text: templateParam(input.url, 300) },
                ],
              },
            ],
          },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.error(`WhatsApp a refusé le message (${response.status}) : ${(await response.text()).slice(0, 500)}`);
        return false;
      }
      return true;
    } catch (error) {
      this.logger.error(`WhatsApp injoignable : ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
}

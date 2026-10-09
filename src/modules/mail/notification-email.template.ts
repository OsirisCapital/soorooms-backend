/**
 * E-mail qui reprend une notification de l'application (même titre, même texte, même page).
 * Tout texte venu d'un utilisateur est échappé ; la version texte affiche le lien en clair.
 */
import { escapeHtml, type RenderedEmail } from './mail.templates.js';

export function notificationEmail(params: {
  fullName: string;
  title: string;
  body: string;
  url: string;
  settingsUrl: string;
}): RenderedEmail {
  const first = params.fullName.trim().split(/\s+/)[0] ?? '';
  const greeting = first ? `Bonjour ${first},` : 'Bonjour,';
  const footer = 'Vous recevez cet e-mail car les notifications par e-mail sont activées sur votre compte SòôRooms.';
  const safeUrl = escapeHtml(params.url);
  const safeSettings = escapeHtml(params.settingsUrl);

  const html = `<!doctype html>
<html lang="fr">
  <body style="margin:0;padding:24px;background:#faf6f0;font-family:Arial,Helvetica,sans-serif;color:#1c2b2b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;padding:32px;">
      <tr><td>
        <p style="margin:0 0 20px;font-size:22px;font-weight:bold;"><span style="color:#c1622e;">Sòô</span><span style="color:#1e4a4a;">Rooms</span></p>
        <h1 style="margin:0 0 16px;font-size:20px;color:#1e4a4a;">${escapeHtml(params.title)}</h1>
        <p style="margin:0 0 12px;line-height:1.5;">${escapeHtml(greeting)}</p>
        <p style="margin:0 0 24px;line-height:1.5;">${escapeHtml(params.body)}</p>
        <p style="margin:0 0 24px;"><a href="${safeUrl}" style="display:inline-block;background:#c1622e;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 24px;border-radius:12px;">Ouvrir dans SòôRooms</a></p>
        <p style="margin:0 0 8px;font-size:13px;color:#555;line-height:1.5;">Le bouton ne fonctionne pas ? Copiez ce lien dans votre navigateur :</p>
        <p style="margin:0 0 24px;font-size:13px;word-break:break-all;"><a href="${safeUrl}" style="color:#1e4a4a;">${safeUrl}</a></p>
        <p style="margin:0;font-size:12px;color:#777;line-height:1.5;">${escapeHtml(footer)} <a href="${safeSettings}" style="color:#1e4a4a;">Gérer mes notifications</a></p>
      </td></tr>
    </table>
  </body>
</html>`;

  return {
    // Retours à la ligne retirés : un objet d'e-mail tient sur une seule ligne.
    subject: `${params.title.replace(/\s+/g, ' ').trim()} — SòôRooms`,
    html,
    text: `${greeting}\n\n${params.body}\n\nOuvrir dans SòôRooms : ${params.url}\n\n${footer}\nGérer mes notifications : ${params.settingsUrl}\n\n— L’équipe SòôRooms`,
  };
}

/**
 * Gabarits des e-mails transactionnels. Tout ce qui vient de l'utilisateur (son nom) est échappé :
 * un nom comme « <script>… » ne doit jamais se retrouver tel quel dans le HTML envoyé.
 * Chaque e-mail a une version texte et affiche le lien en clair, pour les messageries qui
 * bloquent les boutons.
 */
export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? '';
}

function layout(params: { title: string; greeting: string; intro: string; buttonLabel: string; url: string; outro: string }) {
  const { title, greeting, intro, buttonLabel, url, outro } = params;
  const safeUrl = escapeHtml(url);
  return `<!doctype html>
<html lang="fr">
  <body style="margin:0;padding:24px;background:#faf6f0;font-family:Arial,Helvetica,sans-serif;color:#1c2b2b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;padding:32px;">
      <tr><td>
        <p style="margin:0 0 20px;font-size:22px;font-weight:bold;"><span style="color:#c1622e;">Sòô</span><span style="color:#1e4a4a;">Rooms</span></p>
        <h1 style="margin:0 0 16px;font-size:20px;color:#1e4a4a;">${escapeHtml(title)}</h1>
        <p style="margin:0 0 12px;line-height:1.5;">${greeting}</p>
        <p style="margin:0 0 24px;line-height:1.5;">${escapeHtml(intro)}</p>
        <p style="margin:0 0 24px;"><a href="${safeUrl}" style="display:inline-block;background:#c1622e;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 24px;border-radius:12px;">${escapeHtml(buttonLabel)}</a></p>
        <p style="margin:0 0 8px;font-size:13px;color:#555;line-height:1.5;">Le bouton ne fonctionne pas ? Copiez ce lien dans votre navigateur :</p>
        <p style="margin:0 0 24px;font-size:13px;word-break:break-all;"><a href="${safeUrl}" style="color:#1e4a4a;">${safeUrl}</a></p>
        <p style="margin:0;font-size:13px;color:#555;line-height:1.5;">${escapeHtml(outro)}</p>
      </td></tr>
    </table>
  </body>
</html>`;
}

export function verificationEmail(params: { fullName: string; url: string }): RenderedEmail {
  const name = firstName(params.fullName);
  const intro = 'Confirmez votre adresse e-mail pour sécuriser votre compte et pouvoir réinitialiser votre mot de passe en cas d’oubli.';
  const outro = 'Ce lien est valable 24 heures. Si vous n’êtes pas à l’origine de cette demande, ignorez simplement ce message.';
  return {
    subject: 'Confirmez votre adresse e-mail — SòôRooms',
    html: layout({
      title: 'Confirmez votre e-mail',
      greeting: name ? `Bonjour ${escapeHtml(name)},` : 'Bonjour,',
      intro,
      buttonLabel: 'Confirmer mon e-mail',
      url: params.url,
      outro,
    }),
    text: `${name ? `Bonjour ${name},` : 'Bonjour,'}\n\n${intro}\n\nConfirmer mon e-mail : ${params.url}\n\n${outro}\n\n— L’équipe SòôRooms`,
  };
}

export function passwordResetEmail(params: { fullName: string; url: string; validityMinutes: number }): RenderedEmail {
  const name = firstName(params.fullName);
  const intro = 'Vous avez demandé à choisir un nouveau mot de passe pour votre compte SòôRooms.';
  const outro = `Ce lien est valable ${params.validityMinutes} minutes et ne peut servir qu’une fois. Si vous n’avez rien demandé, ignorez ce message : votre mot de passe actuel reste inchangé.`;
  return {
    subject: 'Réinitialisez votre mot de passe — SòôRooms',
    html: layout({
      title: 'Nouveau mot de passe',
      greeting: name ? `Bonjour ${escapeHtml(name)},` : 'Bonjour,',
      intro,
      buttonLabel: 'Choisir un nouveau mot de passe',
      url: params.url,
      outro,
    }),
    text: `${name ? `Bonjour ${name},` : 'Bonjour,'}\n\n${intro}\n\nChoisir un nouveau mot de passe : ${params.url}\n\n${outro}\n\n— L’équipe SòôRooms`,
  };
}

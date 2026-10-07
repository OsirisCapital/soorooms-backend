/**
 * Point d'accès unique et typé à la configuration. Ne jamais lire
 * process.env directement ailleurs dans le code : passer par
 * ConfigService<AppConfig> pour garder un seul endroit de vérité et pouvoir
 * grep facilement toutes les variables utilisées par l'application.
 */
export interface AppConfig {
  nodeEnv: string;
  port: number;
  // Adresse publique du frontend : le retour de Google y redirige l'utilisateur.
  frontendUrl: string;
  databaseUrl: string;
  jwt: {
    accessSecret: string;
    accessExpiresIn: string;
    refreshSecret: string;
    refreshExpiresIn: string;
  };
  google: {
    clientId: string;
    clientSecret: string;
    callbackUrl: string;
  };
  // Envoi d'e-mails transactionnels via Brevo. Sans clé ou sans adresse d'expédition,
  // l'application démarre quand même : les e-mails ne partent simplement pas (voir MailService).
  mail: {
    brevoApiKey: string;
    /** Adresse d'expédition : doit être validée dans Brevo (Senders & IP). */
    fromEmail: string;
    fromName: string;
  };
  payment: {
    platformFeePercent: number;
    // Vides tant que le compte Notch Pay n'est pas configuré : l'application
    // démarre normalement, seules les routes /payments/* échouent alors avec
    // un message explicite. Sandbox et production ont des clés différentes —
    // remplacer les trois ensemble au passage en production.
    notchpay: {
      /** pk_… : en-tête Authorization de toutes les requêtes (création et lecture d'un paiement). */
      publicKey: string;
      /** Clé privée : en-tête X-Grant, réservée aux opérations sensibles (reversements). */
      privateKey: string;
      /** « Hash Key » du webhook : sert uniquement à vérifier la signature des notifications. */
      hashKey: string;
    };
  };
}

export default (): AppConfig => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  frontendUrl: (process.env.FRONTEND_URL ?? 'http://localhost:3001').replace(/\/+$/, ''),
  databaseUrl: process.env.DATABASE_URL ?? '',
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET ?? '',
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? '15m',
    refreshSecret: process.env.JWT_REFRESH_SECRET ?? '',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '7d',
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    callbackUrl: process.env.GOOGLE_CALLBACK_URL ?? '',
  },
  mail: {
    brevoApiKey: process.env.BREVO_API_KEY ?? '',
    fromEmail: process.env.MAIL_FROM_EMAIL ?? '',
    fromName: process.env.MAIL_FROM_NAME ?? 'SòôRooms',
  },
  payment: {
    platformFeePercent: parseInt(process.env.PLATFORM_FEE_PERCENT ?? '10', 10),
    notchpay: {
      publicKey: process.env.NOTCHPAY_PUBLIC_KEY ?? '',
      privateKey: process.env.NOTCHPAY_PRIVATE_KEY ?? '',
      hashKey: process.env.NOTCHPAY_HASH_KEY ?? '',
    },
  },
});

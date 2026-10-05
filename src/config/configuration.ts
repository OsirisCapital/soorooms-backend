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
  payment: {
    // Vides tant que le compte sandbox de l'agrégateur n'est pas prêt —
    // voir PaymentsService : l'application démarre normalement sans ces
    // valeurs, seule la route /payments/* échoue explicitement si on
    // l'appelle avant configuration.
    aggregatorApiKey: string;
    webhookSigningSecret: string;
    platformFeePercent: number;
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
  payment: {
    aggregatorApiKey: process.env.PAYMENT_AGGREGATOR_API_KEY ?? '',
    webhookSigningSecret: process.env.PAYMENT_WEBHOOK_SIGNING_SECRET ?? '',
    platformFeePercent: parseInt(process.env.PLATFORM_FEE_PERCENT ?? '10', 10),
  },
});

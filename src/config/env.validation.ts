/**
 * Validation des variables d'environnement au démarrage. L'application doit
 * planter immédiatement au boot si une variable critique manque, plutôt que
 * de démarrer "à moitié" et échouer silencieusement en production au
 * premier appel qui en a besoin (typiquement un secret JWT manquant).
 */
import { plainToInstance } from 'class-transformer';
import { IsIn, IsNumberString, IsOptional, IsString, MinLength, validateSync } from 'class-validator';

class EnvironmentVariables {
  @IsIn(['development', 'production', 'test'])
  NODE_ENV!: string;

  @IsNumberString()
  PORT!: string;

  @IsString()
  @MinLength(1)
  DATABASE_URL!: string;

  @IsString()
  @MinLength(16, { message: 'JWT_ACCESS_SECRET doit faire au moins 16 caractères' })
  JWT_ACCESS_SECRET!: string;

  @IsString()
  JWT_ACCESS_EXPIRES_IN!: string;

  @IsString()
  @MinLength(16, { message: 'JWT_REFRESH_SECRET doit faire au moins 16 caractères' })
  JWT_REFRESH_SECRET!: string;

  @IsString()
  JWT_REFRESH_EXPIRES_IN!: string;

  // Optionnelles : l'application démarre sans elles, seules les routes de
  // paiement échouent explicitement tant qu'elles ne sont pas fournies.
  @IsOptional()
  @IsString()
  BREVO_API_KEY?: string;

  @IsOptional()
  @IsString()
  MAIL_FROM_EMAIL?: string;

  @IsOptional()
  @IsString()
  MAIL_FROM_NAME?: string;

  @IsOptional()
  @IsString()
  NOTCHPAY_API_URL?: string;

  @IsOptional()
  @IsString()
  NOTCHPAY_PUBLIC_KEY?: string;

  @IsOptional()
  @IsString()
  NOTCHPAY_PRIVATE_KEY?: string;

  @IsOptional()
  @IsString()
  NOTCHPAY_HASH_KEY?: string;

  @IsOptional()
  @IsNumberString()
  PLATFORM_FEE_PERCENT?: string;
}

export function validateEnv(config: Record<string, unknown>) {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, { skipMissingProperties: false });

  if (errors.length > 0) {
    const messages = errors.map((e) => Object.values(e.constraints ?? {}).join(', ')).join(' | ');
    throw new Error(`Configuration invalide au démarrage : ${messages}`);
  }
  return validated;
}

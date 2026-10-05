/**
 * Configuration Prisma 7 (CLI uniquement : generate, migrate, db pull...).
 *
 * Neon (et la plupart des Postgres serverless) fournissent deux types de
 * connexion : une connexion "poolée" (via PgBouncer, contient "-pooler"
 * dans le nom d'hôte) et une connexion directe. Les migrations ont besoin
 * d'une connexion directe et persistante (DDL, verrous de session) — le
 * pooler en mode transaction casse `prisma migrate dev` de façon
 * intermittente. L'application, elle, utilise la connexion poolée à
 * l'exécution via le driver adapter dans PrismaService — voir
 * src/prisma/prisma.service.ts. D'où deux variables d'environnement
 * distinctes : DATABASE_URL (poolée, app) et DIRECT_URL (directe, CLI).
 */
import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('DIRECT_URL'),
  },
});

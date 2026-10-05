/**
 * Prisma 7 exige un driver adapter explicite — plus de connexion implicite
 * via une variable d'environnement lue en interne par PrismaClient. On
 * construit ici un pool `pg` classique et on le passe en adapter,
 * gardé dans le cycle de vie de NestJS (connexion à l'init, fermeture
 * propre à l'arrêt pour ne pas laisser de connexions PostgreSQL orphelines
 * en watch-mode pendant le développement).
 */
import { INestApplication, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './client.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /** Ferme proprement Prisma quand l'application reçoit un signal d'arrêt. */
  async enableShutdownHooks(app: INestApplication) {
    process.on('beforeExit', async () => {
      await app.close();
    });
  }
}

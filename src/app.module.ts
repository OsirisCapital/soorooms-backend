/**
 * Module racine. JwtAuthGuard s'applique à CHAQUE route par défaut (deny by
 * default) ; RolesGuard vérifie ensuite les rôles exigés par @Roles().
 * Ajouter un nouveau module métier ici est la seule étape nécessaire pour
 * l'intégrer à l'application.
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard.js';
import { RolesGuard } from './common/guards/roles.guard.js';
import configuration from './config/configuration.js';
import { validateEnv } from './config/env.validation.js';
import { AdminModule } from './modules/admin/admin.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { BookingsModule } from './modules/bookings/bookings.module.js';
import { FavoritesModule } from './modules/favorites/favorites.module.js';
import { KycModule } from './modules/kyc/kyc.module.js';
import { UploadsModule } from './modules/uploads/uploads.module.js';
import { PaymentsModule } from './modules/payments/payments.module.js';
import { PropertiesModule } from './modules/properties/properties.module.js';
import { RoomsModule } from './modules/rooms/rooms.module.js';
import { SearchModule } from './modules/search/search.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateEnv,
    }),
    // Rate limiting global par défaut : 60 req/min/IP. Resserré sur les
    // routes sensibles (login, register) via @Throttle() au contrôleur.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),
    PrismaModule,
    AuthModule,
    PropertiesModule,
    RoomsModule,
    KycModule,
    BookingsModule,
    SearchModule,
    PaymentsModule,
    AdminModule,
    FavoritesModule,
    UploadsModule,
    NotificationsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}

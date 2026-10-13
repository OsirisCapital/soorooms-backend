/**
 * Point d'entrée. Toute la sécurité HTTP transversale (Helmet, CORS,
 * validation stricte des payloads, documentation) est centralisée ici
 * plutôt que dispersée module par module.
 */
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js';
import { TransformInterceptor } from './common/interceptors/transform.interceptor.js';
import { MonitoringService } from './modules/monitoring/monitoring.service.js';
import { PrismaService } from './prisma/prisma.service.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });

  app.use(helmet());
  app.enableCors({
    origin: process.env.CORS_ORIGIN?.split(',') ?? '*',
    credentials: true,
  });

  // whitelist: supprime silencieusement tout champ non déclaré dans le DTO.
  // forbidNonWhitelisted: rejette la requête si un champ inattendu est
  // présent (ex: tentative d'injection de "role: ADMIN" dans /auth/register).
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const monitoring = app.get(MonitoringService);
  app.useGlobalFilters(new HttpExceptionFilter(monitoring));
  // Une promesse rejetée sans personne pour l'attraper plantait le serveur sans trace : on la garde dans le journal des erreurs.
  process.on('unhandledRejection', (reason) => {
    void monitoring.report({ method: 'PROCESS', path: 'unhandledRejection', status: 500, error: reason });
  });
  app.useGlobalInterceptors(new TransformInterceptor());

  const prismaService = app.get(PrismaService);
  await prismaService.enableShutdownHooks(app);

  const swaggerConfig = new DocumentBuilder()
    .setTitle('SòôRooms API')
    .setDescription('API de réservation de logements — Cameroun / Afrique')
    .setVersion('0.1')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();

/**
 * Uniformise toutes les réponses d'erreur de l'API sous une même forme
 * JSON, et garantit qu'aucune erreur inattendue ne fuite sa stack trace ou
 * des détails internes vers le client en production.
 */
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { MonitoringService } from '../../modules/monitoring/monitoring.service.js';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  /** Le service de surveillance est facultatif : sans lui (tests), le filtre se comporte comme avant. */
  constructor(private readonly monitoring?: MonitoringService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const isHttpException = exception instanceof HttpException;
    const status = isHttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const message = isHttpException ? exception.getResponse() : 'Erreur interne du serveur.';

    if (!isHttpException) {
      // La vraie erreur est loguée côté serveur, jamais renvoyée au client.
      this.logger.error(exception);
    }

    // Toute erreur serveur (5xx) est enregistrée pour l'équipe, sans attendre et sans jamais faire échouer la réponse.
    if (status >= 500) {
      const userId = (request as Request & { user?: { id?: string } }).user?.id ?? null;
      void this.monitoring?.report({ method: request.method, path: request.originalUrl ?? request.url, status, error: exception, userId });
    }

    response.status(status).json({
      statusCode: status,
      path: request.url,
      timestamp: new Date().toISOString(),
      message,
    });
  }
}

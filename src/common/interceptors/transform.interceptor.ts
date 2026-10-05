/**
 * Enveloppe toutes les réponses réussies sous une forme homogène
 * { data, timestamp } pour que le frontend n'ait jamais à gérer deux
 * formes de réponse différentes selon l'endpoint.
 */
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface ApiResponse<T> {
  data: T;
  timestamp: string;
}

@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<T, ApiResponse<T>> {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<ApiResponse<T>> {
    return next.handle().pipe(map((data) => ({ data, timestamp: new Date().toISOString() })));
  }
}

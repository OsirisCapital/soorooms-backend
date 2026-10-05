/**
 * Extrait l'utilisateur authentifié (injecté dans request.user par
 * JwtStrategy) pour l'utiliser directement comme paramètre de méthode,
 * plutôt que de relire manuellement req.user dans chaque contrôleur.
 */
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { UserRole } from '../../prisma/client.js';

export interface AuthenticatedUser {
  id: string;
  role: UserRole;
  phone: string;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);

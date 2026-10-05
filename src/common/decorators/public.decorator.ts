/**
 * Marque explicitement une route comme accessible sans authentification
 * (inscription, connexion, recherche publique de logements...). Sans ce
 * décorateur, JwtAuthGuard bloque tout par défaut — principe "deny by
 * default" : une route qu'on oublie de sécuriser n'est jamais exposée par
 * accident, c'est l'inverse qui doit être explicite.
 */
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

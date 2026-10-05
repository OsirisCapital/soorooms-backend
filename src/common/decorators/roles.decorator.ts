/**
 * Marque une route comme nécessitant un ou plusieurs rôles utilisateur
 * globaux (TRAVELER / HOST / ADMIN). Usage : @Roles('ADMIN')
 * Lu par RolesGuard.
 */
import { SetMetadata } from '@nestjs/common';
import { UserRole } from '../../prisma/client.js';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

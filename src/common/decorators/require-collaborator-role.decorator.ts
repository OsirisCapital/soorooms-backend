/**
 * Restreint une action à un rôle précis de collaborateur sur la Property
 * ciblée par la route — typiquement MANAGER pour l'achat d'un boost ou la
 * modification d'un tarif. Lu par PropertyCollaboratorGuard.
 */
import { SetMetadata } from '@nestjs/common';
import { CollaboratorRole } from '../../prisma/client.js';

export const COLLABORATOR_ROLE_KEY = 'collaboratorRole';
export const RequireCollaboratorRole = (role: CollaboratorRole) =>
  SetMetadata(COLLABORATOR_ROLE_KEY, role);

/**
 * Droit exigé d'un collaborateur sur la Property de la route. Sans cette annotation, PropertyCollaboratorGuard
 * exige « property.edit » (modifier la fiche) : un réceptionniste ou un comptable n'y accède donc jamais par oubli.
 */
import { SetMetadata } from '@nestjs/common';
import type { Capability } from '../utils/collaborator-access.js';

export const COLLABORATOR_CAPABILITY_KEY = 'collaboratorCapability';
export const RequireCapability = (capability: Capability) => SetMetadata(COLLABORATOR_CAPABILITY_KEY, capability);

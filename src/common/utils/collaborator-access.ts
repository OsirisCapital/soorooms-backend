/**
 * Droits des membres de l'équipe d'un logement. Une seule table décide de tout : les routes, les
 * notifications et les écrans la lisent, plutôt que de répéter « role === 'MANAGER' » partout.
 *
 *   MANAGER       Gérant principal : tout (équipe, publication, boosts, visites, attestations)
 *   CO_MANAGER    Gestionnaire : fiche, chambres, réservations ; ni finances ni équipe
 *   AGENT         Agent (rôle d'origine) : fiche, chambres, réservations
 *   RECEPTIONIST  Réceptionniste : réservations et messages seulement
 *   ACCOUNTANT    Comptable : finances seulement
 *
 * Tous les membres peuvent consulter la fiche du logement (property.view).
 *
 * Les actions réservées au gérant principal (publier, inviter, payer une visite…) continuent de
 * demander le rôle MANAGER exact (RequireCollaboratorRole).
 */
import type { CollaboratorRole } from '../../prisma/client.js';

export type Capability = 'property.view' | 'property.edit' | 'bookings.manage' | 'finance.view';

export const ROLE_CAPABILITIES: Record<CollaboratorRole, readonly Capability[]> = {
  MANAGER: ['property.view', 'property.edit', 'bookings.manage', 'finance.view'],
  CO_MANAGER: ['property.view', 'property.edit', 'bookings.manage'],
  AGENT: ['property.view', 'property.edit', 'bookings.manage'],
  RECEPTIONIST: ['property.view', 'bookings.manage'],
  ACCOUNTANT: ['property.view', 'finance.view'],
};

export const COLLABORATOR_ROLE_LABEL: Record<CollaboratorRole, string> = {
  MANAGER: 'Gérant principal',
  CO_MANAGER: 'Gestionnaire',
  AGENT: 'Agent',
  RECEPTIONIST: 'Réceptionniste',
  ACCOUNTANT: 'Comptable',
};

export const can = (role: CollaboratorRole, capability: Capability): boolean => ROLE_CAPABILITIES[role].includes(capability);

/** Rôles qui ont ce droit : sert aux filtres de requêtes (`role: { in: … }`). */
export const rolesWith = (capability: Capability): CollaboratorRole[] =>
  (Object.keys(ROLE_CAPABILITIES) as CollaboratorRole[]).filter((role) => can(role, capability));

/** Identifiants des membres qui ont ce droit (pour les notifications). */
export const userIdsWith = (collaborators: ReadonlyArray<{ userId: string; role: CollaboratorRole }>, capability: Capability): string[] =>
  collaborators.filter((c) => can(c.role, capability)).map((c) => c.userId);

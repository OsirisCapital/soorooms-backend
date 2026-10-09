/**
 * Accès de l'équipe d'administration. Un membre a un NIVEAU (StaffRole) qui fixe ses accès de
 * départ, auxquels le super administrateur peut en ajouter (User.staffPermissions).
 *
 * Seuls les comptes de rôle global ADMIN peuvent avoir des accès : un voyageur dont on aurait
 * rempli par erreur un niveau n'obtient rien.
 */
import type { StaffRole, UserRole } from '../../prisma/client.js';

export const PERMISSIONS = [
  'dashboard.view', // tableau de bord et statistiques
  'kyc.review', // demandes de vérification d'identité et documents
  'disputes.view', // litiges de réservation
  'payments.view', // paiements et séquestre
  'payouts.manage', // versements aux hôtes : voir la file et envoyer
  'users.view', // fiches utilisateurs
  'support.manage', // demandes envoyées au support
  'announcements.manage', // annonces aux utilisateurs
  'releases.manage', // publication des mises à jour de l'application
  'staff.manage', // créer des membres, attribuer niveaux, accès et tâches
  'audit.view', // journal des actions de l'équipe
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<StaffRole, readonly Permission[]> = {
  SUPER_ADMIN: PERMISSIONS,
  KYC_REVIEWER: ['dashboard.view', 'kyc.review'],
  SUPPORT: ['dashboard.view', 'support.manage', 'users.view'],
  FINANCE: ['dashboard.view', 'disputes.view', 'payments.view', 'payouts.manage'],
  CONTENT: ['dashboard.view', 'announcements.manage', 'releases.manage'],
};

export const isPermission = (value: unknown): value is Permission =>
  typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value);

export type StaffIdentity = {
  role: UserRole;
  staffRole: StaffRole | null;
  staffPermissions: string[];
};

/** Niveau réellement appliqué : un ADMIN sans niveau (compte antérieur) est super administrateur. */
export function effectiveStaffRole(user: StaffIdentity): StaffRole | null {
  if (user.role !== 'ADMIN') return null;
  return user.staffRole ?? 'SUPER_ADMIN';
}

/** Tous les accès d'un utilisateur : ceux de son niveau, plus les ajouts valides. Rien hors ADMIN. */
export function permissionsFor(user: StaffIdentity): Permission[] {
  const level = effectiveStaffRole(user);
  if (!level) return [];
  const granted = new Set<Permission>(ROLE_PERMISSIONS[level]);
  for (const extra of user.staffPermissions) {
    if (isPermission(extra)) granted.add(extra);
  }
  return PERMISSIONS.filter((permission) => granted.has(permission));
}

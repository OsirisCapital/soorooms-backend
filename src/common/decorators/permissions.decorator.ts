/**
 * Accès exigé par une route de l'espace d'administration.
 *   @RequirePermission('kyc.review')  → il faut cet accès précis
 *   @StaffOnly()                      → il suffit d'être membre de l'équipe (ex. « quels sont mes accès ? »)
 * Une route d'administration sans l'un des deux est refusée : on n'oublie jamais de la protéger.
 * Lu par PermissionsGuard.
 */
import { SetMetadata } from '@nestjs/common';
import type { Permission } from '../../modules/admin/permissions.js';

export const PERMISSIONS_KEY = 'required-permissions';
export const STAFF_ONLY_KEY = 'staff-only';

export const RequirePermission = (...permissions: Permission[]) => SetMetadata(PERMISSIONS_KEY, permissions);
export const StaffOnly = () => SetMetadata(STAFF_ONLY_KEY, true);

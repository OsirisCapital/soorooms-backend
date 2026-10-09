import type { StaffRole } from '../../prisma/client.js';

export const STAFF_ROLES = ['SUPER_ADMIN', 'KYC_REVIEWER', 'SUPPORT', 'FINANCE', 'CONTENT'] as const satisfies readonly StaffRole[];

export const STAFF_ROLE_LABEL: Record<StaffRole, string> = {
  SUPER_ADMIN: 'Super administrateur',
  KYC_REVIEWER: 'Responsable accréditations',
  SUPPORT: 'Support',
  FINANCE: 'Finance',
  CONTENT: 'Contenu',
};

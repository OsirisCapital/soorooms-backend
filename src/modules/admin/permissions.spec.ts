import { describe, expect, it } from 'vitest';
import { effectiveStaffRole, isPermission, PERMISSIONS, permissionsFor, ROLE_PERMISSIONS } from './permissions.js';

const admin = (staffRole: Parameters<typeof permissionsFor>[0]['staffRole'], staffPermissions: string[] = []) => ({
  role: 'ADMIN' as const,
  staffRole,
  staffPermissions,
});

describe('permissionsFor', () => {
  it('le super administrateur a tous les accès', () => {
    expect(permissionsFor(admin('SUPER_ADMIN'))).toEqual([...PERMISSIONS]);
  });

  it('un ADMIN sans niveau (compte antérieur) garde tous ses accès', () => {
    expect(effectiveStaffRole(admin(null))).toBe('SUPER_ADMIN');
    expect(permissionsFor(admin(null))).toEqual([...PERMISSIONS]);
  });

  it.each(['KYC_REVIEWER', 'SUPPORT', 'FINANCE', 'CONTENT'] as const)("le niveau %s n'a pas les accès d'équipe ni le journal", (level) => {
    const granted = permissionsFor(admin(level));
    expect(granted).not.toContain('staff.manage');
    expect(granted).not.toContain('audit.view');
    expect(granted).toEqual(PERMISSIONS.filter((p) => ROLE_PERMISSIONS[level].includes(p)));
  });

  it("les accès ajoutés s'ajoutent à ceux du niveau, sans doublon et dans l'ordre habituel", () => {
    const granted = permissionsFor(admin('SUPPORT', ['kyc.review', 'support.manage']));
    expect(granted).toEqual(['dashboard.view', 'kyc.review', 'users.view', 'support.manage']);
  });

  it('ignore un accès ajouté qui n\'existe pas', () => {
    expect(permissionsFor(admin('FINANCE', ['tout', 'staff.manage ', '']))).toEqual(permissionsFor(admin('FINANCE')));
  });

  it("n'accorde rien à un compte qui n'est pas ADMIN, même avec un niveau ou des accès renseignés", () => {
    for (const role of ['TRAVELER', 'HOST'] as const) {
      expect(permissionsFor({ role, staffRole: 'SUPER_ADMIN', staffPermissions: ['staff.manage'] })).toEqual([]);
      expect(effectiveStaffRole({ role, staffRole: 'SUPER_ADMIN', staffPermissions: [] })).toBeNull();
    }
  });
});

describe('isPermission', () => {
  it('reconnaît exactement les accès connus', () => {
    expect(isPermission('kyc.review')).toBe(true);
    expect(isPermission('KYC.REVIEW')).toBe(false);
    expect(isPermission(undefined)).toBe(false);
  });
});

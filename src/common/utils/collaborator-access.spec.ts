import { describe, expect, it } from 'vitest';
import { can, rolesWith, userIdsWith } from './collaborator-access.js';

describe('droits des membres', () => {
  it('le gérant principal peut tout', () => {
    expect(can('MANAGER', 'property.edit') && can('MANAGER', 'bookings.manage') && can('MANAGER', 'finance.view')).toBe(true);
  });
  it('le gestionnaire et l’agent gèrent fiche et réservations, pas les finances', () => {
    for (const role of ['CO_MANAGER', 'AGENT'] as const) {
      expect(can(role, 'property.edit')).toBe(true);
      expect(can(role, 'bookings.manage')).toBe(true);
      expect(can(role, 'finance.view')).toBe(false);
    }
  });
  it('le réceptionniste ne touche ni à la fiche ni aux finances', () => {
    expect(can('RECEPTIONIST', 'bookings.manage')).toBe(true);
    expect(can('RECEPTIONIST', 'property.edit')).toBe(false);
    expect(can('RECEPTIONIST', 'finance.view')).toBe(false);
  });
  it('le comptable ne voit que les finances', () => {
    expect(can('ACCOUNTANT', 'finance.view')).toBe(true);
    expect(can('ACCOUNTANT', 'bookings.manage')).toBe(false);
    expect(can('ACCOUNTANT', 'property.edit')).toBe(false);
  });
  it('rolesWith et userIdsWith filtrent par droit', () => {
    expect(rolesWith('finance.view').sort()).toEqual(['ACCOUNTANT', 'MANAGER']);
    const team = [
      { userId: 'a', role: 'MANAGER' as const },
      { userId: 'b', role: 'ACCOUNTANT' as const },
      { userId: 'c', role: 'RECEPTIONIST' as const },
    ];
    expect(userIdsWith(team, 'bookings.manage')).toEqual(['a', 'c']);
  });
});

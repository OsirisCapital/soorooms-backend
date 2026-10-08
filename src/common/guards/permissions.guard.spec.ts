import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import type { Permission } from '../../modules/admin/permissions.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { PERMISSIONS_KEY, STAFF_ONLY_KEY } from '../decorators/permissions.decorator.js';
import { PermissionsGuard } from './permissions.guard.js';

type Account = { role: string; staffRole: string | null; staffPermissions: string[] } | null;

function run(options: { required?: Permission[]; staffOnly?: boolean; account: Account; userId?: string | null }) {
  const reflector = {
    getAllAndOverride: vi.fn((key: string) => (key === PERMISSIONS_KEY ? options.required : key === STAFF_ONLY_KEY ? options.staffOnly : undefined)),
  } as unknown as Reflector;
  const findUnique = vi.fn().mockResolvedValue(options.account);
  const guard = new PermissionsGuard(reflector, { user: { findUnique } } as unknown as PrismaService);
  const userId = options.userId === undefined ? 'u1' : options.userId;
  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ user: userId ? { id: userId } : undefined }) }),
  } as unknown as ExecutionContext;
  return { result: guard.canActivate(context), findUnique };
}

describe('PermissionsGuard', () => {
  it("laisse passer un membre qui a l'accès exigé", async () => {
    const { result } = run({ required: ['kyc.review'], account: { role: 'ADMIN', staffRole: 'KYC_REVIEWER', staffPermissions: [] } });
    await expect(result).resolves.toBe(true);
  });

  it("refuse un membre qui n'a pas cet accès (le support ne voit pas les documents d'identité)", async () => {
    const { result } = run({ required: ['kyc.review'], account: { role: 'ADMIN', staffRole: 'SUPPORT', staffPermissions: [] } });
    await expect(result).rejects.toThrow(ForbiddenException);
  });

  it("quand une route exige plusieurs accès, il les faut tous (un seul ne suffit pas)", async () => {
    const account = { role: 'ADMIN', staffRole: 'KYC_REVIEWER', staffPermissions: [] };
    await expect(run({ required: ['kyc.review', 'staff.manage'], account }).result).rejects.toThrow(ForbiddenException);
    await expect(run({ required: ['kyc.review', 'dashboard.view'], account }).result).resolves.toBe(true);
  });

  it("accepte l'accès ajouté à la main", async () => {
    const { result } = run({ required: ['kyc.review'], account: { role: 'ADMIN', staffRole: 'SUPPORT', staffPermissions: ['kyc.review'] } });
    await expect(result).resolves.toBe(true);
  });

  it('un ADMIN sans niveau garde tous les accès', async () => {
    const { result } = run({ required: ['staff.manage'], account: { role: 'ADMIN', staffRole: null, staffPermissions: [] } });
    await expect(result).resolves.toBe(true);
  });

  it("refuse une route d'administration qui n'a déclaré aucun accès (refus par défaut)", async () => {
    const { result, findUnique } = run({ account: { role: 'ADMIN', staffRole: 'SUPER_ADMIN', staffPermissions: [] } });
    await expect(result).rejects.toThrow(ForbiddenException);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('@StaffOnly : tout membre de l\'équipe passe, un non-admin non', async () => {
    await expect(run({ staffOnly: true, account: { role: 'ADMIN', staffRole: 'CONTENT', staffPermissions: [] } }).result).resolves.toBe(true);
    await expect(run({ staffOnly: true, account: { role: 'HOST', staffRole: null, staffPermissions: [] } }).result).rejects.toThrow(ForbiddenException);
  });

  it("relit les accès en base à chaque appel : un compte devenu non-admin est refusé aussitôt", async () => {
    const { result } = run({ required: ['dashboard.view'], account: { role: 'TRAVELER', staffRole: 'SUPER_ADMIN', staffPermissions: [] } });
    await expect(result).rejects.toThrow(ForbiddenException);
  });

  it('refuse un compte supprimé ou une requête sans utilisateur', async () => {
    await expect(run({ required: ['dashboard.view'], account: null }).result).rejects.toThrow(ForbiddenException);
    const anonymous = run({ required: ['dashboard.view'], account: null, userId: null });
    await expect(anonymous.result).rejects.toThrow(ForbiddenException);
    expect(anonymous.findUnique).not.toHaveBeenCalled();
  });
});

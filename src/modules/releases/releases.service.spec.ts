import { ConflictException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { describe, expect, it, vi } from 'vitest';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator.js';
import { PERMISSIONS_KEY } from '../../common/decorators/permissions.decorator.js';
import { ROLES_KEY } from '../../common/decorators/roles.decorator.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { PublishReleaseDto } from './dto/releases.dto.js';
import { AppVersionController, ReleasesAdminController } from './releases.controller.js';
import { ReleasesService } from './releases.service.js';
import { compareVersions } from './semver.js';

const rel = (version: string, required = false, notes = 'Notes') => ({ id: `id-${version}`, version, notes, required, publishedAt: new Date() });

function make(releases: ReturnType<typeof rel>[] = []) {
  const tx = { appRelease: { create: vi.fn().mockImplementation(async ({ data }) => ({ id: 'new', ...data })), update: vi.fn().mockImplementation(async ({ data }) => ({ id: 'x', ...data })) }, auditLog: { create: vi.fn() } };
  const prisma = {
    appRelease: { findMany: vi.fn().mockResolvedValue(releases), findUnique: vi.fn().mockImplementation(async ({ where }: { where: { id: string } }) => releases.find((r) => r.id === where.id) ?? null) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return { service: new ReleasesService(prisma as unknown as PrismaService), tx };
}

describe('compareVersions', () => {
  it('compare nombre par nombre, pas comme du texte', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.2.0', '1.2.0')).toBe(0);
    expect(compareVersions('0.9.9', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('n’importe quoi', '0.0.1')).toBeLessThan(0);
  });
});

describe('ReleasesService.current', () => {
  it('sans aucune version publiée, rien ne bloque', async () => {
    expect(await make().service.current()).toEqual({ latest: '0.0.0', minSupported: '0.0.0', notes: '' });
  });

  it('donne la dernière version et la plus haute version obligatoire', async () => {
    const { service } = make([rel('1.2.0', true), rel('1.10.0', false, 'Dernières nouveautés'), rel('1.9.0', true), rel('1.1.0')]);
    expect(await service.current()).toEqual({ latest: '1.10.0', minSupported: '1.9.0', notes: 'Dernières nouveautés' });
  });

  it('une version non obligatoire ne bloque personne', async () => {
    const { service } = make([rel('2.0.0', false), rel('1.0.0', false)]);
    expect((await service.current()).minSupported).toBe('0.0.0');
  });
});

describe('ReleasesService.publish', () => {
  it('refuse une version qui ne dépasse pas la dernière (pas de retour en arrière)', async () => {
    const { service, tx } = make([rel('1.2.0')]);
    await expect(service.publish('a1', { version: '1.2.0', notes: 'Notes', required: false })).rejects.toBeInstanceOf(ConflictException);
    await expect(service.publish('a1', { version: '1.1.9', notes: 'Notes', required: false })).rejects.toBeInstanceOf(ConflictException);
    expect(tx.appRelease.create).not.toHaveBeenCalled();
  });

  it('publie et écrit le journal d’audit dans la même transaction', async () => {
    const { service, tx } = make([rel('1.2.0')]);
    await service.publish('a1', { version: '1.3.0', notes: 'Messagerie', required: true });
    expect(tx.appRelease.create).toHaveBeenCalledWith({ data: { version: '1.3.0', notes: 'Messagerie', required: true, publishedById: 'a1' } });
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ actorId: 'a1', action: 'release.publish', meta: { version: '1.3.0', required: true } }) });
  });

  it('retire le caractère obligatoire d’une version et le journalise ; version inconnue : 404', async () => {
    const { service, tx } = make([rel('2.0.0', true)]);
    await service.setRequired('a1', 'id-2.0.0', false);
    expect(tx.appRelease.update).toHaveBeenCalledWith({ where: { id: 'id-2.0.0' }, data: { required: false } });
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'release.required', meta: { version: '2.0.0', required: false } }) });
    await expect(service.setRequired('a1', 'inconnu', true)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('PublishReleaseDto', () => {
  const check = (v: object) => validate(plainToInstance(PublishReleaseDto, v));
  it('n’accepte que x.y.z', async () => {
    expect(await check({ version: '1.2.0', notes: 'Une nouveauté', required: false })).toHaveLength(0);
    for (const version of ['1.2', 'v1.2.0', '1.2.0-beta', '1.2.0; DROP', '']) {
      expect((await check({ version, notes: 'Une nouveauté', required: false })).length, version).toBeGreaterThan(0);
    }
  });
});

describe('Contrôleurs — qui a le droit', () => {
  const reflector = new Reflector();
  it('la version est publique ; la gestion exige ADMIN et « releases.manage »', () => {
    expect(reflector.get(IS_PUBLIC_KEY, AppVersionController.prototype.current)).toBe(true);
    expect(reflector.get(ROLES_KEY, ReleasesAdminController)).toEqual(['ADMIN']);
    expect(reflector.get(PERMISSIONS_KEY, ReleasesAdminController)).toEqual(['releases.manage']);
  });
});

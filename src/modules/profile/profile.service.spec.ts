import { ConflictException, NotFoundException } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { SetAvatarDto } from './dto/set-avatar.dto.js';
import { ProfileService } from './profile.service.js';

function make(count = 1, exists = true) {
  const updateMany = vi.fn().mockResolvedValue({ count });
  const findUnique = vi.fn().mockResolvedValue(exists ? { id: 'u1' } : null);
  return { service: new ProfileService({ user: { updateMany, findUnique } } as unknown as PrismaService), updateMany };
}

describe('ProfileService.setAvatar', () => {
  it("ne modifie que le compte de la personne connectée", async () => {
    const { service, updateMany } = make();
    const url = 'https://res.cloudinary.com/demo/image/upload/v1/soorooms/avatars/abc.jpg';
    expect(await service.setAvatar('u1', url)).toEqual({ avatarUrl: url });
    expect(updateMany).toHaveBeenCalledWith({ where: expect.objectContaining({ id: 'u1' }), data: { avatarUrl: url } });
  });

  it('supprimer la photo remet la valeur à vide', async () => {
    const { service, updateMany } = make();
    expect(await service.setAvatar('u1', null)).toEqual({ avatarUrl: null });
    expect(updateMany).toHaveBeenCalledWith({ where: expect.objectContaining({ id: 'u1' }), data: { avatarUrl: null } });
  });

  it("signale un compte introuvable", async () => {
    await expect(make(0, false).service.setAvatar('ghost', null)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("verrouille la photo pendant et après la vérification d'identité, dans la requête d'écriture elle-même", async () => {
    const { service, updateMany } = make();
    await service.setAvatar('u1', null);
    expect(updateMany.mock.calls[0][0].where).toEqual({
      id: 'u1',
      NOT: { kycStatus: { in: ['PENDING_REVIEW', 'APPROVED'] }, avatarUrl: { contains: '/soorooms/avatars/' } },
    });
  });

  it("répond 409 (et non 404) quand la photo est verrouillée", async () => {
    await expect(make(0, true).service.setAvatar('u1', null)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('SetAvatarDto', () => {
  beforeEach(() => {
    process.env.CLOUDINARY_CLOUD_NAME = 'demo';
  });
  afterEach(() => {
    delete process.env.CLOUDINARY_CLOUD_NAME;
  });
  const errorsFor = (avatarUrl: unknown) => validate(plainToInstance(SetAvatarDto, { avatarUrl }));

  it("accepte une photo envoyée dans le dossier des avatars de NOTRE compte", async () => {
    expect(await errorsFor('https://res.cloudinary.com/demo/image/upload/v123/soorooms/avatars/abc_DEF-1.webp')).toHaveLength(0);
  });

  it.each([
    ['un site extérieur', 'https://exemple.com/moi.jpg'],
    ['un autre compte Cloudinary', 'https://res.cloudinary.com/autre/image/upload/v1/soorooms/avatars/a.jpg'],
    ['une photo de logement', 'https://res.cloudinary.com/demo/image/upload/v1/soorooms/properties/a.jpg'],
    ['un document privé du KYC', 'https://res.cloudinary.com/demo/image/authenticated/v1/soorooms/kyc/a.jpg'],
    ['une valeur vide', ''],
    ['autre chose qu\'un texte', 42],
  ])('refuse %s', async (_label, value) => {
    expect((await errorsFor(value)).length).toBeGreaterThan(0);
  });
});

describe('signature d\'envoi pour une photo de profil', () => {
  it('fige le dossier des avatars, les formats d\'image et la livraison publique', async () => {
    const { UploadsService } = await import('../uploads/uploads.service.js');
    const values: Record<string, string> = { CLOUDINARY_CLOUD_NAME: 'demo', CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: 's' };
    const service = new UploadsService({ get: (key: string) => values[key] } as never);
    const result = service.createSignature('avatar');
    expect(result.folder).toBe('soorooms/avatars');
    expect(result.allowedFormats).toBe('jpg,jpeg,png,webp');
    expect(result.type).toBeUndefined();
  });
});

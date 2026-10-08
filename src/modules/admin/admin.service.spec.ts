import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { UploadsService } from '../uploads/uploads.service.js';
import { AdminService } from './admin.service.js';

const ID_URL = 'https://res.cloudinary.com/demo/image/authenticated/v1/soorooms/kyc/id.jpg';
const PROOF_URL = 'https://res.cloudinary.com/demo/image/authenticated/v1/soorooms/kyc/proof.pdf';

function makeService(document: { idCardUrl: string; proofOfAddressUrl: string | null } | null) {
  const findUnique = vi.fn().mockResolvedValue(document);
  const createViewUrl = vi.fn((url: string) => ({ url: `lien-temporaire-de:${url}`, expiresInSeconds: 600 }));
  const service = new AdminService(
    { kycDocument: { findUnique } } as unknown as PrismaService,
    { createViewUrl } as unknown as UploadsService,
  );
  return { service, findUnique, createViewUrl };
}

let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('AdminService.getKycDocumentLink', () => {
  it("renvoie un lien temporaire pour la pièce d'identité", async () => {
    const { service, findUnique, createViewUrl } = makeService({ idCardUrl: ID_URL, proofOfAddressUrl: PROOF_URL });
    const result = await service.getKycDocumentLink('admin-1', 'doc-1', 'id-card');

    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'doc-1' } }));
    expect(createViewUrl).toHaveBeenCalledWith(ID_URL);
    expect(result).toEqual({ url: `lien-temporaire-de:${ID_URL}`, expiresInSeconds: 600 });
  });

  it('renvoie un lien temporaire pour le justificatif de domicile', async () => {
    const { service, createViewUrl } = makeService({ idCardUrl: ID_URL, proofOfAddressUrl: PROOF_URL });
    await service.getKycDocumentLink('admin-1', 'doc-1', 'proof-of-address');
    expect(createViewUrl).toHaveBeenCalledWith(PROOF_URL);
  });

  it('journalise qui a consulté quel document, sans écrire le lien', async () => {
    const { service } = makeService({ idCardUrl: ID_URL, proofOfAddressUrl: null });
    await service.getKycDocumentLink('admin-1', 'doc-1', 'id-card');

    expect(log).toHaveBeenCalledTimes(1);
    const message = String(log.mock.calls[0][0]);
    expect(message).toContain('admin-1');
    expect(message).toContain('doc-1');
    expect(message).not.toContain('cloudinary');
  });

  it('refuse un type de document inconnu, sans interroger la base ni journaliser', async () => {
    const { service, findUnique } = makeService({ idCardUrl: ID_URL, proofOfAddressUrl: null });
    await expect(service.getKycDocumentLink('admin-1', 'doc-1', 'selfie')).rejects.toThrow(BadRequestException);
    expect(findUnique).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('répond 404 si le document est inconnu, ou si le justificatif de domicile est absent', async () => {
    await expect(makeService(null).service.getKycDocumentLink('admin-1', 'x', 'id-card')).rejects.toThrow(NotFoundException);

    const { service, createViewUrl } = makeService({ idCardUrl: ID_URL, proofOfAddressUrl: null });
    await expect(service.getKycDocumentLink('admin-1', 'doc-1', 'proof-of-address')).rejects.toThrow(NotFoundException);
    expect(createViewUrl).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});

import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { UploadsService } from '../uploads/uploads.service.js';
import { AdminService } from './admin.service.js';
import type { AuditService } from './audit.service.js';

const ID_URL = 'https://res.cloudinary.com/demo/image/authenticated/v1/soorooms/kyc/id.jpg';
const PROOF_URL = 'https://res.cloudinary.com/demo/image/authenticated/v1/soorooms/kyc/proof.pdf';

function makeService(document: { idCardUrl: string; proofOfAddressUrl: string | null } | null) {
  const findUnique = vi.fn().mockResolvedValue(document);
  const createViewUrl = vi.fn((url: string) => ({ url: `lien-temporaire-de:${url}`, expiresInSeconds: 600 }));
  const record = vi.fn().mockResolvedValue({});
  const service = new AdminService(
    { kycDocument: { findUnique } } as unknown as PrismaService,
    { createViewUrl } as unknown as UploadsService,
    { record } as unknown as AuditService,
  );
  return { service, findUnique, createViewUrl, record };
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

  it("écrit dans le journal d'audit qui a ouvert quel document, sans l'adresse du fichier", async () => {
    const { service, record } = makeService({ idCardUrl: ID_URL, proofOfAddressUrl: PROOF_URL });
    await service.getKycDocumentLink('admin-1', 'doc-1', 'proof-of-address');

    expect(record).toHaveBeenCalledWith({
      actorId: 'admin-1',
      action: 'kyc.document.view',
      targetType: 'KycDocument',
      targetId: 'doc-1',
      meta: { kind: 'proof-of-address' },
    });
    expect(JSON.stringify(record.mock.calls[0][0])).not.toContain('cloudinary');
  });

  it("ne montre PAS le document si le journal d'audit ne peut pas être écrit", async () => {
    const { service, record } = makeService({ idCardUrl: ID_URL, proofOfAddressUrl: null });
    record.mockRejectedValue(new Error('base indisponible'));
    await expect(service.getKycDocumentLink('admin-1', 'doc-1', 'id-card')).rejects.toThrow('base indisponible');
  });

  it('refuse un type de document inconnu, sans interroger la base ni journaliser', async () => {
    const { service, findUnique, record } = makeService({ idCardUrl: ID_URL, proofOfAddressUrl: null });
    await expect(service.getKycDocumentLink('admin-1', 'doc-1', 'selfie')).rejects.toThrow(BadRequestException);
    expect(findUnique).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('répond 404 si le document est inconnu, ou si le justificatif de domicile est absent', async () => {
    await expect(makeService(null).service.getKycDocumentLink('admin-1', 'x', 'id-card')).rejects.toThrow(NotFoundException);

    const { service, createViewUrl, record } = makeService({ idCardUrl: ID_URL, proofOfAddressUrl: null });
    await expect(service.getKycDocumentLink('admin-1', 'doc-1', 'proof-of-address')).rejects.toThrow(NotFoundException);
    expect(createViewUrl).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});

describe('AdminService.getMyAccess', () => {
  function serviceFor(account: unknown) {
    const findUnique = vi.fn().mockResolvedValue(account);
    return new AdminService({ user: { findUnique } } as unknown as PrismaService, {} as UploadsService, {} as AuditService);
  }

  it("un ADMIN sans niveau (compte antérieur) est super administrateur, avec tous les accès", async () => {
    const access = await serviceFor({ id: 'a', fullName: 'Admin', role: 'ADMIN', staffRole: null, staffPermissions: [] }).getMyAccess('a');
    expect(access.staffRole).toBe('SUPER_ADMIN');
    expect(access.permissions).toContain('staff.manage');
  });

  it('un membre du support ne reçoit que les accès du support', async () => {
    const access = await serviceFor({ id: 'a', fullName: 'Aïcha', role: 'ADMIN', staffRole: 'SUPPORT', staffPermissions: [] }).getMyAccess('a');
    expect(access.permissions).toEqual(['dashboard.view', 'users.view', 'support.manage']);
  });

  it('répond 404 si le compte a disparu', async () => {
    await expect(serviceFor(null).getMyAccess('x')).rejects.toThrow(NotFoundException);
  });
});

describe('AdminService.listPendingKyc / listKycHistory', () => {
  const when = new Date('2026-10-01T10:00:00Z');

  it('indique le nombre de demandes déjà déposées, pour repérer une nouvelle tentative', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: 'u1', fullName: 'A', phone: '1', email: null, _count: { kycDocuments: 2 }, kycDocuments: [{ id: 'd1', idCardUrl: 'x', proofOfAddressUrl: null, submittedAt: when }] },
    ]);
    const service = new AdminService({ user: { findMany } } as unknown as PrismaService, {} as UploadsService, {} as AuditService);
    const [item] = await service.listPendingKyc();
    expect(item.attempts).toBe(2);
    expect(item.document?.id).toBe('d1');
    expect(item).not.toHaveProperty('_count');
  });

  function historyService(docs: unknown[], audits: unknown[]) {
    const docFind = vi.fn().mockResolvedValue(docs);
    const auditFind = vi.fn().mockResolvedValue(audits);
    const service = new AdminService(
      { kycDocument: { findMany: docFind }, auditLog: { findMany: auditFind } } as unknown as PrismaService,
      {} as UploadsService,
      {} as AuditService,
    );
    return { service, docFind, auditFind };
  }
  const doc = (id: string) => ({ id, status: 'APPROVED', reviewerNote: null, submittedAt: when, reviewedAt: when, user: { id: `user-${id}`, fullName: 'N', phone: '1' } });

  it("associe chaque décision à son auteur d'après le journal, et laisse null quand il est inconnu", async () => {
    const { service } = historyService(
      [doc('d1'), doc('d2')],
      [{ meta: { documentId: 'd1' }, actor: { id: 'admin-1', fullName: 'Aïcha' } }],
    );
    const rows = await service.listKycHistory();
    expect(rows.find((r) => r.id === 'd1')?.reviewer).toEqual({ id: 'admin-1', fullName: 'Aïcha' });
    expect(rows.find((r) => r.id === 'd2')?.reviewer).toBeNull();
  });

  it('borne le nombre de lignes et ne lit pas le journal quand il n\'y a aucune décision', async () => {
    const { service, docFind, auditFind } = historyService([], []);
    expect(await service.listKycHistory(100000)).toEqual([]);
    expect(docFind).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
    expect(auditFind).not.toHaveBeenCalled();
    await service.listKycHistory(-5);
    expect(docFind).toHaveBeenLastCalledWith(expect.objectContaining({ take: 1 }));
  });
});

import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import { KycService } from './kyc.service.js';

function makeService(opts: { pending?: { id: string } | null; updated?: number } = {}) {
  const pending = opts.pending === undefined ? { id: 'doc-1' } : opts.pending;
  const tx = {
    kycDocument: { updateMany: vi.fn().mockResolvedValue({ count: opts.updated ?? 1 }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    user: { update: vi.fn().mockResolvedValue({ id: 'user-1' }) },
  };
  const prisma = {
    kycDocument: { findFirst: vi.fn().mockResolvedValue(pending) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const notifications = { notify: vi.fn().mockResolvedValue(true), notifyStaff: vi.fn().mockResolvedValue(undefined) };
  return { service: new KycService(prisma as unknown as PrismaService, notifications as unknown as NotificationsService), prisma, tx, notifications };
}

describe('KycService.approve', () => {
  it("approuve, passe l'utilisateur à APPROVED et écrit le journal dans la même transaction", async () => {
    const { service, prisma, tx } = makeService();
    await service.approve('admin-1', 'user-1');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.kycDocument.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'doc-1', status: 'PENDING_REVIEW' }, data: expect.objectContaining({ status: 'APPROVED' }) }),
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: { actorId: 'admin-1', action: 'kyc.approve', targetType: 'User', targetId: 'user-1', meta: { documentId: 'doc-1' } },
    });
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'user-1' }, data: { kycStatus: 'APPROVED' } });
  });

  it('refuse qu\'on approuve sa propre vérification, sans rien écrire', async () => {
    const { service, prisma } = makeService();
    await expect(service.approve('user-1', 'user-1')).rejects.toThrow(ForbiddenException);
    expect(prisma.kycDocument.findFirst).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("répond 409 si la demande a été traitée entre-temps, sans journal ni changement d'utilisateur", async () => {
    const { service, tx } = makeService({ updated: 0 });
    await expect(service.approve('admin-1', 'user-1')).rejects.toThrow(ConflictException);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it("répond 404 s'il n'y a aucune demande en attente", async () => {
    const { service, prisma } = makeService({ pending: null });
    await expect(service.approve('admin-1', 'user-1')).rejects.toThrow(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("n'écrit pas la décision si le journal échoue (tout est annulé avec la transaction)", async () => {
    const { service, tx } = makeService();
    tx.auditLog.create.mockRejectedValue(new Error('journal indisponible'));
    await expect(service.approve('admin-1', 'user-1')).rejects.toThrow('journal indisponible');
    expect(tx.user.update).not.toHaveBeenCalled();
  });
});

describe('KycService.reject', () => {
  it('enregistre le motif sur le document et journalise sans recopier le motif', async () => {
    const { service, tx } = makeService();
    await service.reject('admin-1', 'user-1', { reviewerNote: 'Photo floue' });

    expect(tx.kycDocument.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'REJECTED', reviewerNote: 'Photo floue' }) }),
    );
    const entry = tx.auditLog.create.mock.calls[0][0];
    expect(entry.data).toMatchObject({ actorId: 'admin-1', action: 'kyc.reject', targetId: 'user-1' });
    expect(JSON.stringify(entry)).not.toContain('Photo floue');
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'user-1' }, data: { kycStatus: 'REJECTED' } });
  });

  it('refuse qu\'on rejette sa propre vérification et répond 409 si déjà traitée', async () => {
    await expect(makeService().service.reject('u', 'u', { reviewerNote: 'xxxxx' })).rejects.toThrow(ForbiddenException);
    await expect(makeService({ updated: 0 }).service.reject('a', 'u', { reviewerNote: 'xxxxx' })).rejects.toThrow(ConflictException);
  });
});

describe('KycService — notifications', () => {
  it("prévient l'utilisateur de l'approbation, une fois la décision enregistrée", async () => {
    const { service, notifications } = makeService();
    await service.approve('admin-1', 'user-1');
    expect(notifications.notify).toHaveBeenCalledWith('user-1', 'KYC_APPROVED', {});
  });

  it('transmet le motif du refus à la personne concernée', async () => {
    const { service, notifications } = makeService();
    await service.reject('admin-1', 'user-1', { reviewerNote: 'Photo floue' });
    expect(notifications.notify).toHaveBeenCalledWith('user-1', 'KYC_REJECTED', { reason: 'Photo floue' });
  });

  it("n'envoie aucune notification si la décision n'a pas été prise (déjà traitée, ou propre dossier)", async () => {
    const stale = makeService({ updated: 0 });
    await expect(stale.service.approve('admin-1', 'user-1')).rejects.toThrow(ConflictException);
    const own = makeService();
    await expect(own.service.reject('user-1', 'user-1', { reviewerNote: 'xxxxx' })).rejects.toThrow(ForbiddenException);
    expect(stale.notifications.notify).not.toHaveBeenCalled();
    expect(own.notifications.notify).not.toHaveBeenCalled();
  });
});

describe('KycService.submit — alerte équipe', () => {
  it("prévient l'équipe habilitée « kyc.review », sans alerter la personne qui dépose", async () => {
    const tx = {
      kycDocument: { create: vi.fn().mockResolvedValue({ id: 'doc-9' }) },
      user: { update: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      user: { findUnique: vi.fn().mockResolvedValue({ id: 'user-1', fullName: 'Marie Ngo', kycStatus: 'NOT_STARTED' }) },
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const notifications = { notifyStaff: vi.fn().mockResolvedValue(undefined) };
    const service = new KycService(prisma as unknown as PrismaService, notifications as unknown as NotificationsService);

    const url = 'https://res.cloudinary.com/demo/image/authenticated/v1/soorooms/kyc/id.jpg';
    const result = await service.submit('user-1', { idCardUrl: url } as never);

    expect(result).toEqual({ id: 'doc-9' });
    expect(notifications.notifyStaff).toHaveBeenCalledWith('kyc.review', 'KYC_SUBMITTED', { fullName: 'Marie Ngo' }, 'user-1');
  });
});

/**
 * Cycle de vie du KYC : soumission par l'utilisateur, décision (approbation
 * ou rejet) par un ADMIN. On conserve un historique complet dans
 * KycDocument plutôt que d'écraser un champ unique — un rejet doit pouvoir
 * être resoumis, et l'admin doit pouvoir consulter les tentatives passées
 * en cas de litige.
 */
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { RejectKycDto } from './dto/reject-kyc.dto.js';
import type { SubmitKycDto } from './dto/submit-kyc.dto.js';

@Injectable()
export class KycService {
  constructor(private readonly prisma: PrismaService) {}

  async submit(userId: string, dto: SubmitKycDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    if (user?.kycStatus === 'PENDING_REVIEW') {
      throw new ConflictException("Une demande est déjà en cours d'examen.");
    }
    if (user?.kycStatus === 'APPROVED') {
      throw new ConflictException('Votre KYC est déjà approuvé.');
    }

    return this.prisma.$transaction(async (tx) => {
      const document = await tx.kycDocument.create({
        data: {
          userId,
          idCardUrl: dto.idCardUrl,
          proofOfAddressUrl: dto.proofOfAddressUrl,
        },
      });
      await tx.user.update({ where: { id: userId }, data: { kycStatus: 'PENDING_REVIEW' } });
      return document;
    });
  }

  async findMine(userId: string) {
    const [user, documents] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { kycStatus: true } }),
      this.prisma.kycDocument.findMany({ where: { userId }, orderBy: { submittedAt: 'desc' } }),
    ]);
    return { kycStatus: user?.kycStatus, documents };
  }

  async approve(targetUserId: string) {
    const pending = await this.findLatestPending(targetUserId);
    return this.prisma.$transaction(async (tx) => {
      await tx.kycDocument.update({
        where: { id: pending.id },
        data: { status: 'APPROVED', reviewedAt: new Date() },
      });
      return tx.user.update({ where: { id: targetUserId }, data: { kycStatus: 'APPROVED' } });
    });
  }

  async reject(targetUserId: string, dto: RejectKycDto) {
    const pending = await this.findLatestPending(targetUserId);
    return this.prisma.$transaction(async (tx) => {
      await tx.kycDocument.update({
        where: { id: pending.id },
        data: { status: 'REJECTED', reviewedAt: new Date(), reviewerNote: dto.reviewerNote },
      });
      return tx.user.update({ where: { id: targetUserId }, data: { kycStatus: 'REJECTED' } });
    });
  }

  private async findLatestPending(userId: string) {
    const pending = await this.prisma.kycDocument.findFirst({
      where: { userId, status: 'PENDING_REVIEW' },
      orderBy: { submittedAt: 'desc' },
    });
    if (!pending) {
      throw new NotFoundException('Aucune demande KYC en attente pour cet utilisateur.');
    }
    return pending;
  }
}

/**
 * Cycle de vie du KYC : soumission par l'utilisateur, décision (approbation
 * ou rejet) par un ADMIN. On conserve un historique complet dans
 * KycDocument plutôt que d'écraser un champ unique — un rejet doit pouvoir
 * être resoumis, et l'admin doit pouvoir consulter les tentatives passées
 * en cas de litige.
 */
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { withoutPrivateSignature } from '../../common/utils/cloudinary-assets.js';
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
          // Sans la signature Cloudinary : l'adresse gardée en base n'ouvre rien toute seule.
          idCardUrl: withoutPrivateSignature(dto.idCardUrl),
          proofOfAddressUrl: dto.proofOfAddressUrl ? withoutPrivateSignature(dto.proofOfAddressUrl) : undefined,
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

  /**
   * Décision d'un membre de l'équipe. Trois garde-fous :
   *  - personne ne décide sur sa propre vérification ;
   *  - la décision n'est prise que si la demande est TOUJOURS en attente au moment de l'écriture
   *    (deux administrateurs qui cliquent en même temps : un seul l'emporte) ;
   *  - la décision et son inscription au journal d'audit sont écrites ensemble, ou pas du tout.
   */
  async approve(actorId: string, targetUserId: string) {
    this.assertNotSelf(actorId, targetUserId);
    const pending = await this.findLatestPending(targetUserId);
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.kycDocument.updateMany({
        where: { id: pending.id, status: 'PENDING_REVIEW' },
        data: { status: 'APPROVED', reviewedAt: new Date() },
      });
      if (count === 0) throw new ConflictException('Cette demande a déjà été traitée.');
      await tx.auditLog.create({
        data: { actorId, action: 'kyc.approve', targetType: 'User', targetId: targetUserId, meta: { documentId: pending.id } },
      });
      return tx.user.update({ where: { id: targetUserId }, data: { kycStatus: 'APPROVED' } });
    });
  }

  async reject(actorId: string, targetUserId: string, dto: RejectKycDto) {
    this.assertNotSelf(actorId, targetUserId);
    const pending = await this.findLatestPending(targetUserId);
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.kycDocument.updateMany({
        where: { id: pending.id, status: 'PENDING_REVIEW' },
        data: { status: 'REJECTED', reviewedAt: new Date(), reviewerNote: dto.reviewerNote },
      });
      if (count === 0) throw new ConflictException('Cette demande a déjà été traitée.');
      // Le motif reste sur le document ; le journal ne garde que les identifiants.
      await tx.auditLog.create({
        data: { actorId, action: 'kyc.reject', targetType: 'User', targetId: targetUserId, meta: { documentId: pending.id } },
      });
      return tx.user.update({ where: { id: targetUserId }, data: { kycStatus: 'REJECTED' } });
    });
  }

  private assertNotSelf(actorId: string, targetUserId: string) {
    if (actorId === targetUserId) {
      throw new ForbiddenException('Vous ne pouvez pas examiner votre propre vérification.');
    }
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

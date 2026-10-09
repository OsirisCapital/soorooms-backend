/**
 * Lectures réservées aux administrateurs : demandes KYC en attente et
 * litiges ouverts. Les décisions sur le KYC passent par les routes déjà
 * existantes (POST /kyc/:userId/approve|reject) ; les litiges sont ici en
 * lecture seule — la résolution (remboursement ou reversement) suppose un
 * appel à l'agrégateur de paiement, pas encore implémenté.
 */
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { UploadsService } from '../uploads/uploads.service.js';
import { AuditService } from './audit.service.js';
import { effectiveStaffRole, permissionsFor } from './permissions.js';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly uploads: UploadsService,
    private readonly audit: AuditService,
  ) {}

  /** Niveau et accès de la personne connectée : l'interface s'en sert pour n'afficher que ses sections. */
  async getMyAccess(adminId: string) {
    const account = await this.prisma.user.findUnique({
      where: { id: adminId },
      select: { id: true, fullName: true, role: true, staffRole: true, staffPermissions: true },
    });
    if (!account) throw new NotFoundException('Compte introuvable.');
    return {
      id: account.id,
      fullName: account.fullName,
      staffRole: effectiveStaffRole(account),
      permissions: permissionsFor(account),
    };
  }

  /**
   * Lien de consultation d'un document KYC. Chaque consultation est journalisée
   * (qui, quel document) : ce sont des pièces d'identité, on doit pouvoir dire
   * qui les a ouvertes. L'URL elle-même n'est jamais écrite dans le journal.
   */
  async getKycDocumentLink(adminId: string, documentId: string, kind: string) {
    if (kind !== 'id-card' && kind !== 'proof-of-address') {
      throw new BadRequestException("Type de document inconnu : id-card ou proof-of-address.");
    }

    const document = await this.prisma.kycDocument.findUnique({
      where: { id: documentId },
      select: { idCardUrl: true, proofOfAddressUrl: true },
    });
    const storedUrl = kind === 'id-card' ? document?.idCardUrl : document?.proofOfAddressUrl;
    if (!storedUrl) {
      throw new NotFoundException('Document introuvable.');
    }

    const link = this.uploads.createViewUrl(storedUrl);
    // Journal d'audit AVANT de rendre le lien : si l'écriture échoue, le document n'est pas montré.
    await this.audit.record({ actorId: adminId, action: 'kyc.document.view', targetType: 'KycDocument', targetId: documentId, meta: { kind } });
    this.logger.log(`Document KYC ${documentId} (${kind}) consulté par l'administrateur ${adminId}.`);
    return link;
  }

  // Les plus anciennes demandes d'abord : on traite dans l'ordre d'arrivée.
  async listPendingKyc() {
    const users = await this.prisma.user.findMany({
      where: { kycStatus: 'PENDING_REVIEW' },
      select: {
        id: true,
        fullName: true,
        phone: true,
        email: true,
        // Nombre de demandes déjà déposées : au-delà d'une, c'est une nouvelle tentative après refus.
        _count: { select: { kycDocuments: true } },
        kycDocuments: {
          where: { status: 'PENDING_REVIEW' },
          orderBy: { submittedAt: 'desc' },
          take: 1,
             select: { id: true, idCardUrl: true, proofOfAddressUrl: true, profilePhotoUrl: true, submittedAt: true },
        },
      },
    });

    return users
      .map(({ kycDocuments, _count, ...user }) => ({ ...user, attempts: _count.kycDocuments, document: kycDocuments[0] ?? null }))
      .sort((a, b) => (a.document?.submittedAt.getTime() ?? 0) - (b.document?.submittedAt.getTime() ?? 0));
  }

  /**
   * Décisions déjà prises (les plus récentes d'abord), avec leur auteur lu dans le journal d'audit.
   * Le motif d'un refus est celui que l'utilisateur a vu.
   */
  async listKycHistory(limit = 50) {
    const take = Math.min(Math.max(Math.trunc(limit) || 50, 1), 100);
    const documents = await this.prisma.kycDocument.findMany({
      where: { status: { in: ['APPROVED', 'REJECTED'] } },
      orderBy: { reviewedAt: 'desc' },
      take,
      select: {
        id: true,
        status: true,
        reviewerNote: true,
        submittedAt: true,
        reviewedAt: true,
        user: { select: { id: true, fullName: true, phone: true } },
      },
    });
    if (documents.length === 0) return [];

    const decisions = await this.prisma.auditLog.findMany({
      where: { action: { in: ['kyc.approve', 'kyc.reject'] }, targetId: { in: documents.map((d) => d.user.id) } },
      orderBy: { createdAt: 'desc' },
      select: { meta: true, actor: { select: { id: true, fullName: true } } },
    });
    const reviewerOf = new Map<string, { id: string; fullName: string } | null>();
    for (const decision of decisions) {
      const documentId = (decision.meta as { documentId?: unknown } | null)?.documentId;
      if (typeof documentId === 'string' && !reviewerOf.has(documentId)) reviewerOf.set(documentId, decision.actor);
    }
    // Décisions antérieures au journal : relecteur inconnu (null), jamais inventé.
    return documents.map((document) => ({ ...document, reviewer: reviewerOf.get(document.id) ?? null }));
  }

  async listDisputes() {
    return this.prisma.booking.findMany({
      where: { status: 'DISPUTED' },
      select: {
        id: true,
        checkInDate: true,
        checkOutDate: true,
        totalPrice: true,
        disputeReason: true,
        travelerConfirmedAt: true,
        hostConfirmedAt: true,
        updatedAt: true,
        traveler: { select: { id: true, fullName: true, phone: true } },
        room: { select: { name: true, property: { select: { id: true, title: true, city: true } } } },
        escrowVault: { select: { amountHeld: true, status: true } },
      },
      orderBy: { updatedAt: 'asc' },
    });
  }
}

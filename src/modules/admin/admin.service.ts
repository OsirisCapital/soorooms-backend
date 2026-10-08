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

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly uploads: UploadsService,
  ) {}

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
        kycDocuments: {
          where: { status: 'PENDING_REVIEW' },
          orderBy: { submittedAt: 'desc' },
          take: 1,
          select: { id: true, idCardUrl: true, proofOfAddressUrl: true, submittedAt: true },
        },
      },
    });

    return users
      .map(({ kycDocuments, ...user }) => ({ ...user, document: kycDocuments[0] ?? null }))
      .sort((a, b) => (a.document?.submittedAt.getTime() ?? 0) - (b.document?.submittedAt.getTime() ?? 0));
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

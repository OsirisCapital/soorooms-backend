/**
 * Lectures réservées aux administrateurs : demandes KYC en attente et
 * litiges ouverts. Les décisions sur le KYC passent par les routes déjà
 * existantes (POST /kyc/:userId/approve|reject) ; les litiges sont ici en
 * lecture seule — la résolution (remboursement ou reversement) suppose un
 * appel à l'agrégateur de paiement, pas encore implémenté.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

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

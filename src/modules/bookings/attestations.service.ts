import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import {
  ATTESTABLE_STATUSES,
  attestationBlockers,
  buildAttestation,
  generateAttestationCode,
  isForeignCountry,
  normalizeAttestationCode,
  toPublicVerification,
  type Attestation,
} from './attestation.js';

const INCLUDE = {
  traveler: { select: { fullName: true, kycStatus: true } },
  room: { include: { property: { include: { collaborators: true } } } },
  escrowVault: { select: { status: true } },
} as const;

export type AttestationState = {
  status: 'NOT_ELIGIBLE' | 'AVAILABLE' | 'REQUESTED' | 'DECLINED' | 'SIGNED';
  /** Ce qui manque pour pouvoir demander (état NOT_ELIGIBLE). */
  reasons: string[];
  country: string | null;
  declineReason: string | null;
  attestation: Attestation | null;
};

@Injectable()
export class AttestationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  private async load(bookingId: string) {
    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId }, include: INCLUDE });
    if (!booking) throw new NotFoundException('Réservation introuvable.');
    return booking;
  }

  private assertPaid(status: string) {
    if (!(ATTESTABLE_STATUSES as readonly string[]).includes(status)) {
      throw new ConflictException("L'attestation est disponible une fois la réservation payée.");
    }
  }

  private assertManager(booking: Awaited<ReturnType<AttestationsService['load']>>, userId: string) {
    const me = booking.room.property.collaborators.find((c) => c.userId === userId);
    if (!me || me.role !== 'MANAGER') {
      throw new ForbiddenException('Seul un gérant du logement peut traiter une attestation.');
    }
  }

  /** Où en est l'attestation de cette réservation ? Lisible par le voyageur et les gestionnaires. */
  async state(bookingId: string, userId: string): Promise<AttestationState> {
    const booking = await this.load(bookingId);
    const isTraveler = booking.travelerId === userId;
    const isStaff = booking.room.property.collaborators.some((c) => c.userId === userId);
    if (!isTraveler && !isStaff) throw new ForbiddenException("Vous n'êtes pas partie prenante de cette réservation.");

    const attestation = buildAttestation(booking);
    const reasons = attestationBlockers({ status: booking.status, travelerKycStatus: booking.traveler.kycStatus });
    const status: AttestationState['status'] = attestation
      ? 'SIGNED'
      : booking.attestationRequestedAt
        ? 'REQUESTED'
        : booking.attestationDeclinedAt
          ? 'DECLINED'
          : reasons.length > 0
            ? 'NOT_ELIGIBLE'
            : 'AVAILABLE';
    return {
      status,
      reasons: status === 'NOT_ELIGIBLE' ? reasons : [],
      country: booking.attestationCountry,
      declineReason: status === 'DECLINED' ? booking.attestationDeclineReason : null,
      attestation,
    };
  }

  /** Le voyageur demande l'attestation : conditions vérifiées, puis les gérants sont prévenus. */
  async request(bookingId: string, userId: string, country: string) {
    const booking = await this.load(bookingId);
    if (booking.travelerId !== userId) throw new ForbiddenException('Seul le voyageur peut demander son attestation.');
    if (booking.attestationCode) return { alreadySigned: true };

    const reasons = attestationBlockers({ status: booking.status, travelerKycStatus: booking.traveler.kycStatus });
    if (reasons.length > 0) throw new ConflictException(reasons.join(' '));
    if (!isForeignCountry(country)) {
      throw new BadRequestException(
        "L'attestation est réservée aux voyageurs venant de l'étranger. Votre reçu suffit pour un séjour dans votre pays.",
      );
    }

    await this.prisma.booking.update({
      where: { id: bookingId },
      data: {
        attestationRequestedAt: new Date(),
        attestationCountry: country.trim(),
        attestationDeclinedAt: null,
        attestationDeclineReason: null,
      },
    });
    for (const c of booking.room.property.collaborators.filter((c) => c.role === 'MANAGER')) {
      await this.notifications.notify(c.userId, 'ATTESTATION_REQUESTED', {
        bookingId,
        travelerName: booking.traveler.fullName,
        propertyTitle: booking.room.property.title,
      });
    }
    return { alreadySigned: false };
  }

  /** Signature par un gérant, uniquement sur une demande du voyageur. Répéter l'appel ne change rien. */
  async sign(bookingId: string, userId: string) {
    const booking = await this.load(bookingId);
    this.assertManager(booking, userId);
    this.assertPaid(booking.status);
    if (booking.attestationCode) return buildAttestation(booking);
    if (!booking.attestationRequestedAt) {
      throw new ConflictException("Le voyageur n'a pas demandé d'attestation pour cette réservation.");
    }

    const signer = await this.prisma.user.findUnique({ where: { id: userId }, select: { fullName: true } });
    const signedAt = new Date();
    let justSigned = false;
    // Le code est tiré au hasard : en cas (très improbable) de collision, on en tire un autre.
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await this.prisma.booking.updateMany({
          where: { id: bookingId, attestationCode: null },
          data: {
            attestationCode: generateAttestationCode(),
            attestationSignedAt: signedAt,
            attestationSignedById: userId,
            attestationSignerName: signer?.fullName ?? 'Gérant du logement',
          },
        });
        justSigned = result.count > 0; // 0 : un autre gérant vient de signer
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
      }
    }

    const fresh = await this.load(bookingId);
    if (justSigned) {
      await this.notifications.notify(fresh.travelerId, 'ATTESTATION_SIGNED', {
        bookingId,
        propertyTitle: fresh.room.property.title,
      });
    }
    return buildAttestation(fresh);
  }

  /** Refus motivé : le voyageur garde son reçu et peut refaire une demande. */
  async decline(bookingId: string, userId: string, reason: string) {
    const booking = await this.load(bookingId);
    this.assertManager(booking, userId);
    if (booking.attestationCode) throw new ConflictException('Cette attestation est déjà signée.');
    if (!booking.attestationRequestedAt) {
      throw new ConflictException("Le voyageur n'a pas demandé d'attestation pour cette réservation.");
    }
    await this.prisma.booking.update({
      where: { id: bookingId },
      data: { attestationRequestedAt: null, attestationDeclinedAt: new Date(), attestationDeclineReason: reason.trim() },
    });
    await this.notifications.notify(booking.travelerId, 'ATTESTATION_DECLINED', {
      bookingId,
      propertyTitle: booking.room.property.title,
      reason: reason.trim(),
    });
    return { declined: true };
  }

  /** Vérification publique par code : ne renvoie que le strict nécessaire. */
  async verify(rawCode: string) {
    const code = normalizeAttestationCode(rawCode);
    const booking = code.length >= 6
      ? await this.prisma.booking.findUnique({ where: { attestationCode: code }, include: INCLUDE })
      : null;
    const attestation = booking ? buildAttestation(booking) : null;
    if (!attestation) throw new NotFoundException('Aucune attestation ne correspond à ce code.');
    return toPublicVerification(attestation);
  }
}

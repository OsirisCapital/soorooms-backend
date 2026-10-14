/**
 * Programme partenaire : tout utilisateur peut activer un compte partenaire, parrainer des hôtes et des
 * voyageurs avec son code, et gagner une part du revenu que SòôRooms conserve sur leurs réservations.
 *
 * Règles (réglables dans l'administration, voir PartnerConfig) :
 *  - hôte parrainé : 20 % du revenu de SòôRooms pendant 18 mois, à compter de sa première réservation payée ;
 *  - voyageur parrainé : 10 % pendant 6 mois à compter de son inscription ;
 *  - plafond cumulé de 30 % du revenu sur une même réservation ;
 *  - la commission porte sur le revenu RÉELLEMENT conservé (EscrowVault.platformFee une fois la réservation
 *    terminée, annulée ou tranchée par un litige) : pas de commission sur ce qui est remboursé, et rien n'est repris
 *    sur ce qui a été gagné ;
 *  - un seul niveau : un partenaire ne gagne rien sur les partenaires qu'il a recrutés ;
 *  - rien sur ses propres logements ou réservations.
 */
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type { SetPayoutDetailsDto } from '../payments/dto/payout-details.dto.js';
import { normalizeCameroonMobile } from '../payments/payout-phone.js';
import { addMonths, computeCommission, generateCode, namesMatch, normalizeCode, PARTNER_TERMS, splitWithholding } from './partners.utils.js';

const RECENT_CHANGE_MS = 72 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN_PAYOUT: ('REQUESTED' | 'SENDING' | 'FAILED')[] = ['REQUESTED', 'SENDING', 'FAILED'];

const isUniqueViolation = (e: unknown) => typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
const num = (v: { toString(): string } | number | null | undefined) => (v == null ? 0 : Number(v.toString()));
const firstName = (full: string) => full.trim().split(/\s+/)[0] ?? 'Quelqu’un';
/** « Awa N. » : un partenaire voit qui il a amené, pas son nom complet. */
export function maskName(full: string): string {
  const parts = full.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1]![0]!.toUpperCase()}.` : (parts[0] ?? '');
}

export type PartnerConfigView = {
  enabled: boolean;
  hostRatePercent: number;
  hostMonths: number;
  travelerRatePercent: number;
  travelerMonths: number;
  capPercent: number;
  minPayout: number;
  withholdingPercent: number;
  claimWindowDays: number;
  termsVersion: string;
};

@Injectable()
export class PartnersService {
  private readonly logger = new Logger(PartnersService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  // ---------------------------------------------------------------------
  // Réglages
  // ---------------------------------------------------------------------

  async getConfig(): Promise<PartnerConfigView> {
    let row = await this.prisma.partnerConfig.findUnique({ where: { id: 'default' } });
    if (!row) {
      try {
        row = await this.prisma.partnerConfig.create({ data: { id: 'default' } });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        row = await this.prisma.partnerConfig.findUnique({ where: { id: 'default' } });
      }
    }
    if (!row) throw new NotFoundException('Réglages du programme introuvables.');
    return {
      enabled: row.enabled,
      hostRatePercent: num(row.hostRatePercent),
      hostMonths: row.hostMonths,
      travelerRatePercent: num(row.travelerRatePercent),
      travelerMonths: row.travelerMonths,
      capPercent: num(row.capPercent),
      minPayout: row.minPayout,
      withholdingPercent: num(row.withholdingPercent),
      claimWindowDays: row.claimWindowDays,
      termsVersion: row.termsVersion,
    };
  }

  // ---------------------------------------------------------------------
  // Compte partenaire
  // ---------------------------------------------------------------------

  async balanceOf(partnerId: string) {
    const [earned, reserved, paid] = await Promise.all([
      this.prisma.partnerCommission.aggregate({ where: { partnerId }, _sum: { amount: true } }),
      this.prisma.partnerPayout.aggregate({ where: { partnerId, status: { not: 'REJECTED' } }, _sum: { gross: true } }),
      this.prisma.partnerPayout.aggregate({ where: { partnerId, status: 'PAID' }, _sum: { net: true } }),
    ]);
    const earnedTotal = num(earned._sum.amount);
    const reservedTotal = num(reserved._sum.gross);
    return { earned: earnedTotal, withdrawn: num(paid._sum.net), available: Math.max(0, earnedTotal - reservedTotal) };
  }

  /** Tout ce que la page « Partenaire » affiche : null tant que le compte partenaire n'est pas activé. */
  async me(userId: string) {
    const config = await this.getConfig();
    const partner = await this.prisma.partnerProfile.findUnique({ where: { userId } });
    const base = { config, terms: PARTNER_TERMS };
    if (!partner) {
      const account = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
      const blockedReason = account?.role === 'ADMIN' ? 'STAFF' : !config.enabled ? 'CLOSED' : null;
      return { ...base, canActivate: blockedReason === null, blockedReason, partner: null };
    }
    const [user, balance, referralCount, hostCount, pending] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { fullName: true, kycStatus: true, role: true } }),
      this.balanceOf(partner.id),
      this.prisma.partnerReferral.count({ where: { partnerId: partner.id } }),
      this.prisma.partnerReferral.count({ where: { partnerId: partner.id, hostStartedAt: { not: null } } }),
      this.prisma.partnerPayout.findFirst({ where: { partnerId: partner.id, status: { in: OPEN_PAYOUT } }, select: { id: true } }),
    ]);
    const complete = !!(partner.payoutChannel && partner.payoutPhone && partner.payoutAccountName);
    // Un membre de l'équipe ne gagne plus de commission tant qu'il en fait partie (voir accrue) : calculé à la volée,
    // donc rien à défaire quand il quitte l'équipe. Les gains déjà acquis restent retirables.
    const earningBlockedReason = user?.role === 'ADMIN' ? 'STAFF' : partner.status !== 'ACTIVE' ? 'SUSPENDED' : !config.enabled ? 'CLOSED' : null;
    return {
      ...base,
      canActivate: false,
      blockedReason: null,
      partner: {
        earning: earningBlockedReason === null,
        earningBlockedReason,
        code: partner.code,
        status: partner.status,
        suspendedReason: partner.suspendedReason,
        termsVersion: partner.termsVersion,
        needsTerms: partner.termsVersion !== config.termsVersion,
        kycStatus: user?.kycStatus ?? 'NOT_SUBMITTED',
        fullName: user?.fullName ?? '',
        payout: complete
          ? { channel: partner.payoutChannel, phone: partner.payoutPhone, accountName: partner.payoutAccountName, updatedAt: partner.payoutUpdatedAt }
          : null,
        payoutRecentlyChanged: !!partner.payoutUpdatedAt && Date.now() - partner.payoutUpdatedAt.getTime() < RECENT_CHANGE_MS,
        referrals: referralCount,
        activeHosts: hostCount,
        balance,
        hasOpenPayout: !!pending,
      },
    };
  }

  async activate(userId: string, acceptTerms: boolean) {
    if (!acceptTerms) throw new BadRequestException('Acceptez les conditions du programme pour continuer.');
    const config = await this.getConfig();
    if (!config.enabled) throw new ConflictException('Le programme partenaire est momentanément fermé.');
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (!user) throw new NotFoundException('Compte introuvable.');
    if (user.role === 'ADMIN') throw new ForbiddenException("Les comptes de l'équipe SòôRooms ne peuvent pas être partenaires.");

    const existing = await this.prisma.partnerProfile.findUnique({ where: { userId } });
    if (existing) {
      if (existing.termsVersion !== config.termsVersion) {
        await this.prisma.partnerProfile.update({ where: { id: existing.id }, data: { termsVersion: config.termsVersion, termsAcceptedAt: new Date() } });
      }
      return this.me(userId);
    }
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        await this.prisma.partnerProfile.create({ data: { userId, code: generateCode(), termsVersion: config.termsVersion, termsAcceptedAt: new Date() } });
        return this.me(userId);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        if (await this.prisma.partnerProfile.findUnique({ where: { userId }, select: { id: true } })) return this.me(userId);
      }
    }
    throw new ConflictException("Impossible de créer votre code pour l'instant : réessayez.");
  }

  async setPayoutDetails(userId: string, dto: SetPayoutDetailsDto) {
    const partner = await this.requirePartner(userId);
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { fullName: true } });
    const phone = normalizeCameroonMobile(dto.phone);
    if (!phone) throw new BadRequestException('Numéro invalide : indiquez un numéro mobile camerounais (9 chiffres, commençant par 6).');
    const accountName = dto.accountName.replace(/\s+/g, ' ').trim();
    if (!user || !namesMatch(accountName, user.fullName)) {
      throw new BadRequestException(`Le compte doit être à votre nom, tel que sur votre pièce d'identité (« ${user?.fullName ?? ''} »).`);
    }
    await this.prisma.partnerProfile.update({
      where: { id: partner.id },
      data: { payoutChannel: dto.channel, payoutPhone: phone, payoutAccountName: accountName, payoutUpdatedAt: new Date() },
    });
    return this.me(userId);
  }

  async listReferrals(userId: string) {
    const partner = await this.requirePartner(userId);
    const rows = await this.prisma.partnerReferral.findMany({
      where: { partnerId: partner.id },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { referredUser: { select: { fullName: true, role: true } } },
    });
    const sums = await this.prisma.partnerCommission.groupBy({ by: ['referralId'], where: { partnerId: partner.id }, _sum: { amount: true } });
    const byRef = new Map(sums.map((s) => [s.referralId, num(s._sum.amount)]));
    return rows.map((r) => ({
      id: r.id,
      name: maskName(r.referredUser.fullName),
      joinedAt: r.createdAt,
      hostStartedAt: r.hostStartedAt,
      hostEndsAt: r.hostEndsAt,
      travelerEndsAt: r.travelerEndsAt,
      earned: byRef.get(r.id) ?? 0,
    }));
  }

  async listCommissions(userId: string) {
    const partner = await this.requirePartner(userId);
    const rows = await this.prisma.partnerCommission.findMany({
      where: { partnerId: partner.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, kind: true, revenue: true, ratePercent: true, amount: true, createdAt: true },
    });
    return rows.map((r) => ({ id: r.id, kind: r.kind, revenue: num(r.revenue), ratePercent: num(r.ratePercent), amount: num(r.amount), createdAt: r.createdAt }));
  }

  async listPayouts(userId: string) {
    const partner = await this.requirePartner(userId);
    const rows = await this.prisma.partnerPayout.findMany({
      where: { partnerId: partner.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, gross: true, withholding: true, net: true, status: true, failureReason: true, decidedNote: true, createdAt: true, paidAt: true },
    });
    return rows.map((r) => ({ ...r, gross: num(r.gross), withholding: num(r.withholding), net: num(r.net) }));
  }

  // ---------------------------------------------------------------------
  // Rattachement d'un nouvel utilisateur à un parrain
  // ---------------------------------------------------------------------

  /**
   * Appelée par l'application juste après une inscription ou une connexion, avec le code mémorisé par le lien
   * de parrainage. Un compte n'a qu'un parrain, et seulement durant ses premiers jours.
   */
  async claim(userId: string, rawCode: string) {
    const config = await this.getConfig();
    if (!config.enabled) throw new ConflictException('Le programme partenaire est momentanément fermé.');
    const partner = await this.prisma.partnerProfile.findUnique({ where: { code: normalizeCode(rawCode) }, select: { id: true, userId: true, status: true } });
    if (!partner || partner.status !== 'ACTIVE') throw new NotFoundException('Code de parrainage inconnu.');
    if (partner.userId === userId) throw new BadRequestException('Vous ne pouvez pas utiliser votre propre code.');

    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true, createdAt: true, fullName: true, partnerProfile: { select: { id: true } } } });
    if (!user || user.role === 'ADMIN') throw new ForbiddenException('Ce compte ne peut pas être parrainé.');

    const existing = await this.prisma.partnerReferral.findUnique({ where: { referredUserId: userId }, select: { partnerId: true } });
    if (existing) {
      if (existing.partnerId === partner.id) return { ok: true, already: true };
      throw new ConflictException('Ce compte est déjà rattaché à un parrain.');
    }
    if (Date.now() - user.createdAt.getTime() > config.claimWindowDays * DAY_MS) {
      throw new ConflictException(`Le parrainage doit être enregistré dans les ${config.claimWindowDays} jours qui suivent l'inscription.`);
    }
    // Pas de boucle : on ne peut pas être parrainé par quelqu'un que l'on a soi-même parrainé.
    if (user.partnerProfile) {
      const loop = await this.prisma.partnerReferral.findFirst({ where: { partnerId: user.partnerProfile.id, referredUserId: partner.userId }, select: { id: true } });
      if (loop) throw new ConflictException('Ce parrainage n’est pas possible.');
    }
    const booked = await this.prisma.booking.count({ where: { travelerId: userId, status: { in: ['CONFIRMED_ESCROW', 'COMPLETED'] } } });
    if (booked > 0) throw new ConflictException('Ce compte a déjà réservé : le parrainage ne peut plus être enregistré.');

    try {
      await this.prisma.partnerReferral.create({
        data: { partnerId: partner.id, referredUserId: userId, travelerEndsAt: addMonths(new Date(), config.travelerMonths) },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('Ce compte est déjà rattaché à un parrain.');
      throw error;
    }
    await this.notifications?.notify(partner.userId, 'PARTNER_REFERRAL_JOINED', { name: firstName(user.fullName) }).catch(() => undefined);
    return { ok: true, already: false };
  }

  // ---------------------------------------------------------------------
  // Commissions (appelées à la clôture d'une réservation)
  // ---------------------------------------------------------------------

  /** Ne lève jamais : une commission ne doit pas empêcher de clore une réservation. Idempotente. */
  async accrueForBooking(bookingId: string): Promise<void> {
    try {
      await this.accrue(bookingId);
    } catch (error) {
      this.logger.error(`Commission non calculée (réservation ${bookingId}) : ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async accrue(bookingId: string) {
    const config = await this.getConfig();
    if (!config.enabled) return;
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        createdAt: true,
        status: true,
        travelerId: true,
        room: { select: { property: { select: { title: true, collaborators: { where: { role: 'MANAGER' }, select: { userId: true }, take: 1 } } } } },
        escrowVault: { select: { platformFee: true } },
      },
    });
    if (!booking || (booking.status !== 'COMPLETED' && booking.status !== 'CANCELLED')) return;
    const revenue = num(booking.escrowVault?.platformFee);
    if (revenue <= 0) return;
    const hostId = booking.room.property.collaborators[0]?.userId ?? null;

    const ids = [booking.travelerId, ...(hostId ? [hostId] : [])];
    const referrals = await this.prisma.partnerReferral.findMany({
      where: { referredUserId: { in: ids } },
      include: { partner: { select: { id: true, userId: true, status: true, payoutPhone: true, user: { select: { role: true } } } } },
    });
    if (referrals.length === 0) return;
    const hostPhone = hostId ? (await this.prisma.hostProfile.findUnique({ where: { userId: hostId }, select: { payoutPhone: true } }))?.payoutPhone ?? null : null;

    // L'hôte parrainé passe en premier : si le plafond est réduit, c'est le voyageur qui est rogné.
    const ordered = [...referrals].sort((a, b) => Number(b.referredUserId === hostId) - Number(a.referredUserId === hostId));
    for (const ref of ordered) {
      const kind = ref.referredUserId === hostId ? 'HOST' : 'TRAVELER';
      const partner = ref.partner;
      if (partner.status !== 'ACTIVE') continue;
      // Conflit d'intérêts : un membre de l'équipe ne perçoit aucune commission pendant qu'il en fait partie.
      if (partner.user.role === 'ADMIN') continue;
      // Aucune commission sur ses propres logements ou réservations, ni sur un hôte payé sur le même numéro.
      if (partner.userId === hostId || partner.userId === booking.travelerId) continue;
      if (hostPhone && partner.payoutPhone && partner.payoutPhone === hostPhone) continue;

      let endsAt: Date;
      if (kind === 'HOST') {
        if (ref.hostEndsAt) {
          endsAt = ref.hostEndsAt;
        } else {
          endsAt = addMonths(booking.createdAt, config.hostMonths);
          await this.prisma.partnerReferral.updateMany({ where: { id: ref.id, hostEndsAt: null }, data: { hostStartedAt: booking.createdAt, hostEndsAt: endsAt } });
        }
      } else {
        endsAt = ref.travelerEndsAt;
      }
      if (booking.createdAt.getTime() > endsAt.getTime()) continue;

      const ratePercent = kind === 'HOST' ? config.hostRatePercent : config.travelerRatePercent;
      const amount = await this.prisma.$transaction(async (tx) => {
        const already = await tx.partnerCommission.aggregate({ where: { bookingId }, _sum: { amount: true } });
        const value = computeCommission({ revenue, ratePercent, capPercent: config.capPercent, alreadyGranted: num(already._sum.amount) });
        if (value <= 0) return 0;
        try {
          await tx.partnerCommission.create({ data: { partnerId: partner.id, referralId: ref.id, bookingId, kind, revenue, ratePercent, amount: value } });
        } catch (error) {
          if (isUniqueViolation(error)) return 0; // déjà comptée : on rejoue sans rien ajouter
          throw error;
        }
        return value;
      });
      if (amount > 0) {
        await this.notifications?.notify(partner.userId, 'PARTNER_COMMISSION_EARNED', { amount, kind, propertyTitle: booking.room.property.title }).catch(() => undefined);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Retrait
  // ---------------------------------------------------------------------

  async requestPayout(userId: string) {
    const partner = await this.requirePartner(userId);
    if (partner.status !== 'ACTIVE') throw new ForbiddenException('Votre compte partenaire est suspendu.');
    const [config, user] = await Promise.all([
      this.getConfig(),
      this.prisma.user.findUnique({ where: { id: userId }, select: { fullName: true, kycStatus: true } }),
    ]);
    if (!user || user.kycStatus !== 'APPROVED') {
      throw new BadRequestException("Faites d'abord vérifier votre identité (pièce d'identité et photo de profil) : c'est nécessaire pour retirer vos gains.");
    }
    if (!partner.payoutChannel || !partner.payoutPhone || !partner.payoutAccountName) {
      throw new BadRequestException('Indiquez d’abord votre compte Mobile Money.');
    }
    if (!namesMatch(partner.payoutAccountName, user.fullName)) {
      throw new BadRequestException("Le compte Mobile Money doit être à votre nom, tel que sur votre pièce d'identité.");
    }
    if (partner.payoutUpdatedAt && Date.now() - partner.payoutUpdatedAt.getTime() < RECENT_CHANGE_MS) {
      throw new ConflictException('Votre compte de retrait a changé il y a moins de 72 h : par sécurité, le retrait sera possible ensuite.');
    }
    const payoutDetails = { channel: partner.payoutChannel, phone: partner.payoutPhone, accountName: partner.payoutAccountName };

    const created = await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "PartnerProfile" WHERE id = ${partner.id} FOR UPDATE`;
        const open = await tx.partnerPayout.findFirst({ where: { partnerId: partner.id, status: { in: OPEN_PAYOUT } }, select: { id: true } });
        if (open) throw new ConflictException('Un retrait est déjà en cours de traitement.');
        const [earned, reserved] = await Promise.all([
          tx.partnerCommission.aggregate({ where: { partnerId: partner.id }, _sum: { amount: true } }),
          tx.partnerPayout.aggregate({ where: { partnerId: partner.id, status: { not: 'REJECTED' } }, _sum: { gross: true } }),
        ]);
        const available = num(earned._sum.amount) - num(reserved._sum.gross);
        if (available < config.minPayout) {
          throw new BadRequestException(`Le retrait minimum est de ${config.minPayout.toLocaleString('fr-FR')} FCFA. Votre solde disponible est de ${Math.max(0, available).toLocaleString('fr-FR')} FCFA.`);
        }
        const { withholding, net } = splitWithholding(available, config.withholdingPercent);
        const payout = await tx.partnerPayout.create({
          data: { partnerId: partner.id, gross: available, withholding, net, ...payoutDetails },
        });
        await tx.auditLog.create({ data: { actorId: userId, action: 'partner.payout.request', targetType: 'PartnerPayout', targetId: payout.id, meta: { gross: available, withholding, net } } });
        return payout;
      },
      { timeout: 15_000 },
    );
    await this.notifications?.notifyStaff('partners.manage', 'PARTNER_PAYOUT_REQUESTED_STAFF', { amount: num(created.net) }).catch(() => undefined);
    return this.me(userId);
  }

  private async requirePartner(userId: string) {
    const partner = await this.prisma.partnerProfile.findUnique({ where: { userId } });
    if (!partner) throw new NotFoundException("Vous n'avez pas encore activé votre compte partenaire.");
    return partner;
  }
}

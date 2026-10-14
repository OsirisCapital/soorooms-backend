/**
 * Côté équipe : liste des partenaires, réglages du programme, et file des retraits (même circuit que les
 * versements aux hôtes : validation par la finance, envoi Mobile Money par Notch Pay ou virement fait à la main).
 * Règle d'or contre le double envoi, identique à PayoutsService : un échec n'autorise un nouvel essai que si
 * l'agrégateur a clairement refusé ; au moindre doute le retrait reste « SENDING » et seul « Vérifier » tranche.
 */
import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import type { PartnerPayoutStatus } from '../../prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PAYMENT_GATEWAY, type PaymentGateway, type PayoutChannel, type TransferState } from '../payments/interfaces/payment-gateway.interface.js';
import { isDefiniteRejection } from '../payments/payouts.service.js';
import type { UpdatePartnerConfigDto } from './dto/partners.dto.js';
import { PartnersService, maskName } from './partners.service.js';
import { namesMatch } from './partners.utils.js';

const SENDABLE: PartnerPayoutStatus[] = ['REQUESTED', 'FAILED'];
const RECENT_CHANGE_MS = 72 * 60 * 60 * 1000;
const num = (v: { toString(): string } | null | undefined) => (v == null ? 0 : Number(v.toString()));

@Injectable()
export class PartnersAdminService {
  private readonly logger = new Logger(PartnersAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly partners: PartnersService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  // ---------------------------------------------------------------------
  // Partenaires
  // ---------------------------------------------------------------------

  async listPartners() {
    const rows = await this.prisma.partnerProfile.findMany({
      orderBy: { createdAt: 'desc' },
      take: 300,
      include: { user: { select: { fullName: true, phone: true, kycStatus: true } }, _count: { select: { referrals: true } } },
    });
    const [earned, reserved] = await Promise.all([
      this.prisma.partnerCommission.groupBy({ by: ['partnerId'], _sum: { amount: true } }),
      this.prisma.partnerPayout.groupBy({ by: ['partnerId'], where: { status: { not: 'REJECTED' } }, _sum: { gross: true } }),
    ]);
    const e = new Map(earned.map((x) => [x.partnerId, num(x._sum.amount)]));
    const r = new Map(reserved.map((x) => [x.partnerId, num(x._sum.gross)]));
    return rows.map((p) => ({
      id: p.id,
      code: p.code,
      status: p.status,
      suspendedReason: p.suspendedReason,
      createdAt: p.createdAt,
      fullName: p.user.fullName,
      phone: p.user.phone,
      kycStatus: p.user.kycStatus,
      userId: p.userId,
      referrals: p._count.referrals,
      earned: e.get(p.id) ?? 0,
      available: Math.max(0, (e.get(p.id) ?? 0) - (r.get(p.id) ?? 0)),
    }));
  }

  async partnerDetail(id: string) {
    const p = await this.prisma.partnerProfile.findUnique({
      where: { id },
      include: {
        user: { select: { fullName: true, phone: true, email: true, kycStatus: true } },
        referrals: { orderBy: { createdAt: 'desc' }, take: 100, include: { referredUser: { select: { fullName: true } } } },
        commissions: { orderBy: { createdAt: 'desc' }, take: 100 },
        payouts: { orderBy: { createdAt: 'desc' }, take: 50 },
      },
    });
    if (!p) throw new NotFoundException('Partenaire introuvable.');
    return {
      id: p.id,
      code: p.code,
      status: p.status,
      suspendedReason: p.suspendedReason,
      termsVersion: p.termsVersion,
      termsAcceptedAt: p.termsAcceptedAt,
      createdAt: p.createdAt,
      user: p.user,
      payout: p.payoutPhone ? { channel: p.payoutChannel, phone: p.payoutPhone, accountName: p.payoutAccountName, updatedAt: p.payoutUpdatedAt } : null,
      balance: await this.partners.balanceOf(p.id),
      referrals: p.referrals.map((r) => ({ id: r.id, name: maskName(r.referredUser.fullName), joinedAt: r.createdAt, hostStartedAt: r.hostStartedAt, hostEndsAt: r.hostEndsAt, travelerEndsAt: r.travelerEndsAt })),
      commissions: p.commissions.map((c) => ({ id: c.id, kind: c.kind, bookingId: c.bookingId, revenue: num(c.revenue), ratePercent: num(c.ratePercent), amount: num(c.amount), createdAt: c.createdAt })),
      payouts: p.payouts.map((x) => ({ id: x.id, gross: num(x.gross), withholding: num(x.withholding), net: num(x.net), status: x.status, createdAt: x.createdAt, paidAt: x.paidAt })),
    };
  }

  async setSuspended(id: string, actorId: string, suspended: boolean, reason?: string) {
    const note = reason?.trim() || null;
    if (suspended && !note) throw new BadRequestException('Indiquez le motif de la suspension.');
    const res = await this.prisma.partnerProfile.updateMany({
      where: { id, status: suspended ? 'ACTIVE' : 'SUSPENDED' },
      data: { status: suspended ? 'SUSPENDED' : 'ACTIVE', suspendedReason: suspended ? note : null },
    });
    if (res.count === 0) throw new ConflictException(suspended ? 'Ce partenaire est déjà suspendu.' : "Ce partenaire n'est pas suspendu.");
    await this.prisma.auditLog.create({ data: { actorId, action: suspended ? 'partner.suspend' : 'partner.reactivate', targetType: 'PartnerProfile', targetId: id, meta: { reason: note } } });
    return this.partnerDetail(id);
  }

  // ---------------------------------------------------------------------
  // Réglages
  // ---------------------------------------------------------------------

  getConfig() {
    return this.partners.getConfig();
  }

  async updateConfig(actorId: string, dto: UpdatePartnerConfigDto) {
    await this.partners.getConfig(); // crée la ligne si besoin
    const data = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined));
    if (Object.keys(data).length > 0) {
      await this.prisma.partnerConfig.update({ where: { id: 'default' }, data: { ...data, updatedById: actorId } });
      await this.prisma.auditLog.create({ data: { actorId, action: 'partner.config', targetType: 'PartnerConfig', targetId: 'default', meta: data } });
    }
    return this.partners.getConfig();
  }

  // ---------------------------------------------------------------------
  // Retraits
  // ---------------------------------------------------------------------

  async listPayouts(view: 'open' | 'done') {
    const rows = await this.prisma.partnerPayout.findMany({
      where: { status: { in: view === 'open' ? ['REQUESTED', 'SENDING', 'FAILED'] : ['PAID', 'REJECTED'] } },
      orderBy: { createdAt: view === 'open' ? 'asc' : 'desc' },
      take: 200,
      include: { partner: { select: { id: true, code: true, status: true, payoutUpdatedAt: true, user: { select: { fullName: true, phone: true, kycStatus: true } } } } },
    });
    const now = Date.now();
    return rows.map((r) => {
      const kycOk = r.partner.user.kycStatus === 'APPROVED';
      const nameOk = namesMatch(r.accountName, r.partner.user.fullName);
      return {
        id: r.id,
        partnerId: r.partner.id,
        code: r.partner.code,
        partnerStatus: r.partner.status,
        fullName: r.partner.user.fullName,
        phone: r.partner.user.phone,
        gross: num(r.gross),
        withholding: num(r.withholding),
        net: num(r.net),
        status: r.status,
        attempts: r.attempts,
        failureReason: r.failureReason,
        decidedNote: r.decidedNote,
        createdAt: r.createdAt,
        sentAt: r.sentAt,
        paidAt: r.paidAt,
        beneficiary: { channel: r.channel, phone: r.phone, accountName: r.accountName },
        kycApproved: kycOk,
        nameMatches: nameOk,
        detailsRecentlyChanged: r.partner.payoutUpdatedAt ? now - r.partner.payoutUpdatedAt.getTime() < RECENT_CHANGE_MS : false,
        canSend: SENDABLE.includes(r.status) && kycOk && nameOk && r.partner.status === 'ACTIVE',
        canCheck: r.status === 'SENDING' && !!r.reference,
        canMarkPaid: SENDABLE.includes(r.status),
        canReject: SENDABLE.includes(r.status),
      };
    });
  }

  async send(id: string, actorId: string) {
    const payout = await this.prisma.partnerPayout.findUnique({ where: { id }, include: { partner: { select: { status: true, user: { select: { fullName: true, kycStatus: true } } } } } });
    if (!payout) throw new NotFoundException('Retrait introuvable.');
    if (!SENDABLE.includes(payout.status)) {
      throw new ConflictException(payout.status === 'PAID' ? 'Ce retrait a déjà été effectué.' : payout.status === 'REJECTED' ? 'Ce retrait a été refusé.' : 'Ce retrait est déjà en cours : utilisez « Vérifier ».');
    }
    if (payout.partner.status !== 'ACTIVE') throw new ConflictException('Ce partenaire est suspendu.');
    if (payout.partner.user.kycStatus !== 'APPROVED') throw new ConflictException("L'identité de ce partenaire n'est pas (ou plus) vérifiée.");
    if (!namesMatch(payout.accountName, payout.partner.user.fullName)) throw new ConflictException("Le nom du compte ne correspond pas à celui du partenaire.");

    const attempt = payout.attempts + 1;
    const reference = `pp_${payout.id}_${attempt}`;
    const amount = num(payout.net);
    const claimed = await this.prisma.$transaction(async (tx) => {
      const res = await tx.partnerPayout.updateMany({
        where: { id: payout.id, status: { in: SENDABLE }, attempts: payout.attempts },
        data: { status: 'SENDING', attempts: attempt, reference, gatewayRef: null, failureReason: null, decidedById: actorId, sentAt: new Date() },
      });
      if (res.count === 0) return false;
      await tx.auditLog.create({ data: { actorId, action: 'partner.payout.send', targetType: 'PartnerPayout', targetId: payout.id, meta: { amount, attempt, reference } } });
      return true;
    });
    if (!claimed) throw new ConflictException('Ce retrait vient d’être pris en charge par quelqu’un d’autre.');

    try {
      const state = await this.gateway.sendTransfer({
        amount,
        currency: 'XAF',
        reference,
        description: 'Commission partenaire SòôRooms',
        beneficiary: { name: payout.accountName, phone: payout.phone, channel: payout.channel as PayoutChannel },
      });
      await this.applyState(payout.id, state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Retrait partenaire ${payout.id} (tentative ${attempt}) : ${message}`);
      if (isDefiniteRejection(error)) {
        await this.markFailed(payout.id, message);
      } else {
        await this.prisma.partnerPayout.updateMany({ where: { id: payout.id, status: 'SENDING' }, data: { failureReason: 'Réponse de Notch Pay inconnue : cliquez sur « Vérifier » avant tout nouvel essai.' } });
      }
    }
    return this.view(payout.id);
  }

  async markPaid(id: string, actorId: string, proof: string) {
    const payout = await this.prisma.partnerPayout.findUnique({ where: { id } });
    if (!payout) throw new NotFoundException('Retrait introuvable.');
    if (!SENDABLE.includes(payout.status)) throw new ConflictException(payout.status === 'PAID' ? 'Ce retrait a déjà été effectué.' : 'Ce retrait ne peut plus être marqué comme payé (envoi en cours ou refusé).');
    const reference = proof.trim().slice(0, 80);
    const res = await this.prisma.$transaction(async (tx) => {
      const r = await tx.partnerPayout.updateMany({
        where: { id, status: { in: SENDABLE }, attempts: payout.attempts },
        data: { status: 'PAID', paidAt: new Date(), sentAt: new Date(), decidedById: actorId, gatewayRef: `manuel:${reference}`, failureReason: null },
      });
      if (r.count === 0) return false;
      await tx.auditLog.create({ data: { actorId, action: 'partner.payout.manual_paid', targetType: 'PartnerPayout', targetId: id, meta: { amount: num(payout.net), proof: reference } } });
      return true;
    });
    if (!res) throw new ConflictException('Ce retrait vient d’être pris en charge par quelqu’un d’autre.');
    await this.notifyPaid(id);
    return this.view(id);
  }

  async reject(id: string, actorId: string, reason: string) {
    const payout = await this.prisma.partnerPayout.findUnique({ where: { id }, include: { partner: { select: { userId: true } } } });
    if (!payout) throw new NotFoundException('Retrait introuvable.');
    const note = reason.trim().slice(0, 300);
    const ok = await this.prisma.$transaction(async (tx) => {
      const r = await tx.partnerPayout.updateMany({ where: { id, status: { in: SENDABLE } }, data: { status: 'REJECTED', decidedById: actorId, decidedNote: note } });
      if (r.count === 0) return false;
      await tx.auditLog.create({ data: { actorId, action: 'partner.payout.reject', targetType: 'PartnerPayout', targetId: id, meta: { reason: note } } });
      return true;
    });
    if (!ok) throw new ConflictException('Ce retrait ne peut plus être refusé (déjà envoyé ou traité).');
    // Refusé : le montant redevient disponible dans le solde du partenaire.
    await this.notifications?.notify(payout.partner.userId, 'PARTNER_PAYOUT_REJECTED', { reason: note }).catch(() => undefined);
    return this.view(id);
  }

  async check(id: string, actorId: string) {
    const payout = await this.prisma.partnerPayout.findUnique({ where: { id } });
    if (!payout) throw new NotFoundException('Retrait introuvable.');
    if (payout.status !== 'SENDING' || !payout.reference) throw new ConflictException("Ce retrait n'a pas d'envoi à vérifier.");
    const state = await this.gateway.getTransfer(payout.reference);
    if (!state) await this.markFailed(payout.id, "Notch Pay n'a pas reçu l'ordre d'envoi. Vous pouvez réessayer.");
    else await this.applyState(payout.id, state);
    await this.prisma.auditLog.create({ data: { actorId, action: 'partner.payout.check', targetType: 'PartnerPayout', targetId: id } });
    return this.view(id);
  }

  // ---------------------------------------------------------------------

  private async view(id: string) {
    return (await this.listPayouts('open')).find((p) => p.id === id) ?? (await this.listPayouts('done')).find((p) => p.id === id) ?? null;
  }

  private async markFailed(id: string, reason: string) {
    await this.prisma.partnerPayout.updateMany({ where: { id, status: 'SENDING' }, data: { status: 'FAILED', failureReason: reason.slice(0, 300) } });
  }

  private async applyState(id: string, state: TransferState) {
    if (state.status === 'COMPLETE') {
      const r = await this.prisma.partnerPayout.updateMany({ where: { id, status: { in: ['SENDING', 'FAILED'] } }, data: { status: 'PAID', paidAt: new Date(), gatewayRef: state.gatewayRef, failureReason: null } });
      if (r.count > 0) await this.notifyPaid(id);
      return;
    }
    if (state.status === 'FAILED') {
      await this.markFailed(id, state.failureReason ?? 'Transfert refusé par Notch Pay.');
      return;
    }
    await this.prisma.partnerPayout.updateMany({ where: { id, status: 'SENDING' }, data: { gatewayRef: state.gatewayRef, failureReason: null } });
  }

  private async notifyPaid(id: string) {
    try {
      const p = await this.prisma.partnerPayout.findUnique({ where: { id }, select: { net: true, partner: { select: { userId: true } } } });
      if (p) await this.notifications?.notify(p.partner.userId, 'PARTNER_PAYOUT_SENT', { amount: num(p.net) });
    } catch (error) {
      this.logger.error(`Alerte de retrait non envoyée : ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

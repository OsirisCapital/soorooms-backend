/**
 * Paiement d'une visite de vérification, par l'hôte, avec la même passerelle que les séjours.
 *
 * Différences avec un séjour : pas de séquestre (la visite est un service de SòôRooms, payé à
 * l'avance), et la référence envoyée à l'agrégateur porte l'identifiant de la VISITE à la place de
 * celui d'une réservation (les deux sont des UUID : aucune confusion possible).
 * Comme pour un séjour, un paiement n'est jamais cru sur parole : on relit toujours l'agrégateur,
 * et il doit désigner cette visite, en XAF, au montant exact.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import {
  PAYMENT_GATEWAY,
  type NormalizedWebhookEvent,
  type PaymentCustomer,
  type PaymentGateway,
} from './interfaces/payment-gateway.interface.js';

@Injectable()
export class VisitPaymentsService {
  private readonly logger = new Logger(VisitPaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService<AppConfig, true>,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  private async loadForManager(taskId: string, userId: string) {
    const task = await this.prisma.verificationTask.findUnique({
      where: { id: taskId },
      include: { property: { select: { id: true, title: true } } },
    });
    if (!task) throw new NotFoundException('Visite introuvable.');
    const link = await this.prisma.propertyCollaborator.findFirst({
      where: { propertyId: task.propertyId, userId, role: 'MANAGER' },
    });
    if (!link) throw new ForbiddenException('Seul le gérant de ce logement peut payer cette visite.');
    return task;
  }

  async initiate(taskId: string, userId: string) {
    const task = await this.loadForManager(taskId, userId);
    if (task.status !== 'AWAITING_PAYMENT') throw new ConflictException('Cette visite est déjà payée.');
    if (task.amount == null) throw new ConflictException('Le prix de cette visite est introuvable.');

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { fullName: true, phone: true, email: true },
    });
    if (!user) throw new NotFoundException('Compte introuvable.');

    const frontendUrl = this.configService.get('frontendUrl', { infer: true });
    const { paymentUrl, gatewayRef } = await this.gateway.initiatePayment({
      amount: Number(task.amount),
      currency: 'XAF',
      // Référence neuve à chaque tentative (l'agrégateur refuse deux fois la même) ; l'id de la visite en est extrait au retour.
      reference: `${task.id}_${Date.now().toString(36)}`,
      description: `Visite de vérification — ${task.property.title}`,
      customer: this.buildCustomer(user),
      callbackUrl: `${frontendUrl}/hote/logements/${task.propertyId}/verification`,
    });
    return { paymentUrl, gatewayRef };
  }

  /** Au retour de l'hôte sur sa page : relit le paiement chez l'agrégateur, sans dépendre du webhook. */
  async verifyReturn(taskId: string, userId: string, reference: string) {
    const task = await this.loadForManager(taskId, userId);
    if (task.status !== 'AWAITING_PAYMENT') {
      return { confirmed: true, paymentStatus: 'SUCCESS' as const };
    }
    const verified = await this.gateway.verifyPayment(reference);
    if (verified.bookingReference !== task.id) {
      this.logger.error(`Retour de paiement : ${verified.gatewayRef} se rattache à « ${verified.bookingReference ?? 'aucune référence'} », pas à la visite ${task.id}.`);
      throw new ForbiddenException('Ce paiement ne correspond pas à cette visite.');
    }
    if (verified.status === 'PENDING') return { confirmed: false, paymentStatus: 'PENDING' as const };
    if (verified.status === 'FAILED') return { confirmed: false, paymentStatus: 'FAILED' as const };

    this.assertPaidAmount(verified, task.amount);
    await this.markPaid(task.id, verified.gatewayRef);
    return { confirmed: true, paymentStatus: 'SUCCESS' as const };
  }

  /** Webhook d'une visite (appelé par PaymentsService quand la référence désigne une visite). */
  async handleWebhook(event: NormalizedWebhookEvent) {
    // Un échec ou un paiement en cours ne change rien : l'hôte peut simplement réessayer.
    if (event.status !== 'SUCCESS') return { processed: true };
    const task = await this.prisma.verificationTask.findUnique({ where: { id: event.bookingReference } });
    if (!task) throw new NotFoundException('Visite introuvable.');
    if (task.status !== 'AWAITING_PAYMENT') return { alreadyProcessed: true };

    const verified = await this.gateway.verifyPayment(event.gatewayRef);
    if (verified.status !== 'SUCCESS') {
      throw new ConflictException("Paiement non confirmé par l'agrégateur.");
    }
    this.assertPaidAmount(verified, task.amount);
    await this.markPaid(task.id, verified.gatewayRef);
    return { processed: true };
  }

  private assertPaidAmount(verified: { currency: string; amount: number; gatewayRef: string }, expected: { toString(): string } | null) {
    if (verified.currency !== 'XAF') {
      this.logger.error(`Paiement de visite ${verified.gatewayRef} : devise ${verified.currency || 'absente'} au lieu de XAF.`);
      throw new BadRequestException('Devise du paiement inattendue.');
    }
    if (expected == null || Math.round(verified.amount) !== Math.round(Number(expected.toString()))) {
      this.logger.error(`Paiement de visite ${verified.gatewayRef} : montant ${verified.amount} ≠ attendu ${String(expected)}. Vérification manuelle requise.`);
      throw new BadRequestException('Montant du paiement différent du montant attendu.');
    }
  }

  /** Idempotent : seule la visite encore AWAITING_PAYMENT avance, une seule fois. */
  private async markPaid(taskId: string, gatewayRef: string) {
    const moved = await this.prisma.verificationTask.updateMany({
      where: { id: taskId, status: 'AWAITING_PAYMENT' },
      data: { status: 'PENDING_ASSIGNMENT', paidAt: new Date(), paymentGatewayId: gatewayRef },
    });
    if (moved.count === 0) return;
    await this.notifyPaid(taskId);
  }

  private async notifyPaid(taskId: string) {
    if (!this.notifications) return;
    try {
      const task = await this.prisma.verificationTask.findUnique({
        where: { id: taskId },
        include: { property: { select: { id: true, title: true, collaborators: { where: { role: 'MANAGER' }, select: { userId: true } } } } },
      });
      if (!task) return;
      await this.notifications.notifyMany(
        task.property.collaborators.map((c) => c.userId),
        'VISIT_PAID',
        { propertyId: task.property.id, propertyTitle: task.property.title },
      );
      await this.notifications.notifyStaff('visits.manage', 'VISIT_PAID_STAFF', { propertyTitle: task.property.title });
    } catch (error) {
      this.logger.error(`Alertes de visite payée non envoyées (${taskId}) : ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private buildCustomer(user: { fullName: string; phone: string; email: string | null }): PaymentCustomer {
    // Les comptes Google ont un numéro factice « google:<id> » : jamais transmis à l'agrégateur.
    const phone = /^\+?\d{8,15}$/.test(user.phone) ? user.phone : undefined;
    const email = user.email ?? undefined;
    if (!phone && !email) {
      throw new BadRequestException('Ajoutez un numéro de téléphone ou une adresse e-mail à votre compte avant de payer.');
    }
    return { name: user.fullName, phone, email };
  }
}

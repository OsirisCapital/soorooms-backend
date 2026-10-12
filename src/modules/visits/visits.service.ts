/**
 * Visites de vérification payantes. L'hôte (gérant) demande et paie une visite ; l'équipe choisit un
 * agent de terrain ; l'agent remplit la grille, joint ses photos et tranche. Un logement conforme
 * reçoit le badge « Vérifié par SòôRooms » (Property.isVerifiedByAgent), visible dans la recherche.
 *
 * Le paiement lui-même est dans payments/visit-payments.service.ts (même passerelle que les séjours).
 */
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { permissionsFor } from '../admin/permissions.js';
import { FeesService } from '../fees/fees.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type { SubmitVisitReportDto } from './dto/visit.dto.js';
import { CHECKLIST_ITEMS, OPEN_VISIT_STATUSES, checkVerdict, parseChecklist } from './visit.utils.js';

type Status = 'AWAITING_PAYMENT' | 'PENDING_ASSIGNMENT' | 'ASSIGNED' | 'COMPLETED' | 'REJECTED';
const OPEN = [...OPEN_VISIT_STATUSES] as Status[];

type TaskRow = {
  id: string;
  propertyId: string;
  status: Status;
  amount: { toString(): string } | null;
  paidAt: Date | null;
  assignedAt: Date | null;
  visitedAt: Date | null;
  checklist: unknown;
  photoUrls: string[];
  inspectionReport: string | null;
  createdAt: Date;
  agent?: { id: string; fullName: string } | null;
  property?: { id: string; title: string; city: string; quarter: string } | null;
};

const taskView = (t: TaskRow) => ({
  id: t.id,
  status: t.status,
  amount: t.amount == null ? null : Number(t.amount.toString()),
  paidAt: t.paidAt,
  assignedAt: t.assignedAt,
  visitedAt: t.visitedAt,
  createdAt: t.createdAt,
  agentName: t.agent?.fullName ?? null,
  property: t.property ?? undefined,
});

/** Le rapport n'est montré (à l'hôte comme à l'équipe) qu'une fois la visite terminée. */
const reportView = (t: TaskRow) =>
  t.status === 'COMPLETED' || t.status === 'REJECTED'
    ? { conforming: t.status === 'COMPLETED', checklist: t.checklist, photoUrls: t.photoUrls, report: t.inspectionReport }
    : null;

@Injectable()
export class VisitsService {
  private readonly logger = new Logger(VisitsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fees: FeesService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  /** Seul un gérant (MANAGER) engage de l'argent pour le logement ; un simple agent collaborateur non. */
  private async assertManager(propertyId: string, userId: string) {
    const link = await this.prisma.propertyCollaborator.findFirst({ where: { propertyId, userId, role: 'MANAGER' } });
    if (!link) throw new ForbiddenException('Seul le gérant de ce logement peut demander une visite de vérification.');
  }

  private async managerIds(propertyId: string): Promise<string[]> {
    const rows = await this.prisma.propertyCollaborator.findMany({ where: { propertyId, role: 'MANAGER' }, select: { userId: true } });
    return rows.map((r) => r.userId);
  }

  // --- Hôte -------------------------------------------------------------

  async overview(propertyId: string, userId: string) {
    await this.assertManager(propertyId, userId);
    const property = await this.prisma.property.findUnique({
      where: { id: propertyId },
      select: { id: true, title: true, isVerifiedByAgent: true, verifiedAt: true },
    });
    if (!property) throw new NotFoundException('Logement introuvable.');

    const [price, rows] = await Promise.all([
      this.fees.visitPrice(),
      this.prisma.verificationTask.findMany({
        where: { propertyId },
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: { agent: { select: { id: true, fullName: true } } },
      }),
    ]);
    const tasks = rows as unknown as TaskRow[];
    return {
      property: { id: property.id, title: property.title, verified: property.isVerifiedByAgent, verifiedAt: property.verifiedAt },
      price,
      checklist: CHECKLIST_ITEMS,
      current: tasks.find((t) => OPEN.includes(t.status)) ? taskView(tasks.find((t) => OPEN.includes(t.status)) as TaskRow) : null,
      history: tasks.filter((t) => !OPEN.includes(t.status)).map((t) => ({ ...taskView(t), result: reportView(t) })),
    };
  }

  /** Crée la demande (à payer) ; si une demande non payée existe déjà, la reprend au prix du jour. */
  async request(propertyId: string, userId: string) {
    await this.assertManager(propertyId, userId);
    const property = await this.prisma.property.findUnique({
      where: { id: propertyId },
      select: { id: true, status: true, isVerifiedByAgent: true },
    });
    if (!property) throw new NotFoundException('Logement introuvable.');
    if (property.status === 'SUSPENDED') throw new ConflictException('Ce logement est suspendu : une visite ne peut pas être demandée.');
    if (property.isVerifiedByAgent) throw new ConflictException('Ce logement est déjà vérifié par SòôRooms.');

    const price = await this.fees.visitPrice();
    const open = (await this.prisma.verificationTask.findFirst({
      where: { propertyId, status: { in: OPEN as never } },
      orderBy: { createdAt: 'desc' },
    })) as TaskRow | null;

    if (open) {
      if (open.status !== 'AWAITING_PAYMENT') {
        throw new ConflictException('Une visite est déjà payée et en cours pour ce logement.');
      }
      const updated = await this.prisma.verificationTask.update({ where: { id: open.id }, data: { amount: price } });
      return taskView(updated as unknown as TaskRow);
    }

    const created = await this.prisma.verificationTask.create({
      data: { propertyId, requestType: 'EXPRESS_PAID', status: 'AWAITING_PAYMENT', requestedById: userId, amount: price },
    });
    return taskView(created as unknown as TaskRow);
  }

  // --- Équipe -----------------------------------------------------------

  /** File de l'équipe : les visites payées d'abord (à assigner), puis en cours, puis terminées. */
  async list(status?: Status) {
    const rows = (await this.prisma.verificationTask.findMany({
      where: status ? { status } : { status: { not: 'AWAITING_PAYMENT' } },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        agent: { select: { id: true, fullName: true } },
        property: { select: { id: true, title: true, city: true, quarter: true } },
      },
    })) as unknown as TaskRow[];
    const rank: Record<Status, number> = { PENDING_ASSIGNMENT: 0, ASSIGNED: 1, COMPLETED: 2, REJECTED: 2, AWAITING_PAYMENT: 3 };
    return rows.map((t) => ({ ...taskView(t), result: reportView(t) })).sort((a, b) => rank[a.status] - rank[b.status]);
  }

  /** Membres de l'équipe qui peuvent réaliser une visite. */
  async agents() {
    const admins = await this.prisma.user.findMany({
      where: { role: 'ADMIN' },
      select: { id: true, fullName: true, role: true, staffRole: true, staffPermissions: true },
    });
    return admins
      .filter((a) => permissionsFor(a).includes('visits.perform'))
      .map((a) => ({ id: a.id, fullName: a.fullName }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
  }

  async assign(taskId: string, agentId: string) {
    const agents = await this.agents();
    if (!agents.some((a) => a.id === agentId)) {
      throw new BadRequestException("Cette personne ne peut pas réaliser de visite : donnez-lui d'abord le niveau « Agent de terrain ».");
    }
    const task = await this.prisma.verificationTask.findUnique({
      where: { id: taskId },
      include: { property: { select: { title: true, city: true } } },
    });
    if (!task) throw new NotFoundException('Visite introuvable.');

    const moved = await this.prisma.verificationTask.updateMany({
      where: { id: taskId, status: { in: ['PENDING_ASSIGNMENT', 'ASSIGNED'] } },
      data: { agentId, status: 'ASSIGNED', assignedAt: new Date() },
    });
    if (moved.count === 0) throw new ConflictException("Cette visite n'attend plus d'agent (non payée ou déjà terminée).");

    await this.notifications?.notify(agentId, 'VISIT_ASSIGNED', {
      visitId: taskId,
      propertyTitle: task.property.title,
      city: task.property.city,
    });
    return { assigned: true };
  }

  /** Détail complet pour l'équipe. */
  async adminDetail(taskId: string) {
    const row = await this.detailRow(taskId);
    return { ...taskView(row), result: reportView(row), ...(await this.siteInfo(row)) };
  }

  // --- Agent ------------------------------------------------------------

  async mine(agentId: string) {
    const rows = (await this.prisma.verificationTask.findMany({
      where: { agentId },
      orderBy: { assignedAt: 'desc' },
      take: 50,
      include: { property: { select: { id: true, title: true, city: true, quarter: true } } },
    })) as unknown as TaskRow[];
    return rows.map(taskView).sort((a, b) => Number(b.status === 'ASSIGNED') - Number(a.status === 'ASSIGNED'));
  }

  async agentDetail(taskId: string, agentId: string) {
    const row = await this.detailRow(taskId);
    const owner = (await this.prisma.verificationTask.findUnique({ where: { id: taskId }, select: { agentId: true } }))?.agentId;
    if (owner !== agentId) throw new ForbiddenException("Cette visite ne vous est pas confiée.");
    return { ...taskView(row), result: reportView(row), checklist: CHECKLIST_ITEMS, ...(await this.siteInfo(row)) };
  }

  async submit(taskId: string, agentId: string, dto: SubmitVisitReportDto) {
    const task = await this.prisma.verificationTask.findUnique({
      where: { id: taskId },
      include: { property: { select: { id: true, title: true } } },
    });
    if (!task) throw new NotFoundException('Visite introuvable.');
    if (task.agentId !== agentId) throw new ForbiddenException("Cette visite ne vous est pas confiée.");
    if (task.status !== 'ASSIGNED') throw new ConflictException('Cette visite est déjà terminée ou pas encore assignée.');

    const checklist = parseChecklist(dto.checklist);
    if (!checklist) throw new BadRequestException('La grille de contrôle doit être remplie en entier.');
    const verdict = checkVerdict({ conforming: dto.conforming, checklist, photoCount: dto.photoUrls.length, report: dto.report });
    if (!verdict.ok) throw new BadRequestException(verdict.message);

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.verificationTask.updateMany({
        where: { id: taskId, status: 'ASSIGNED', agentId },
        data: {
          status: dto.conforming ? 'COMPLETED' : 'REJECTED',
          visitedAt: now,
          checklist: checklist as never,
          photoUrls: dto.photoUrls,
          inspectionReport: dto.report.trim() || null,
        },
      });
      if (moved.count === 0) throw new ConflictException('Cette visite vient déjà d’être clôturée.');
      if (dto.conforming) {
        await tx.property.update({
          where: { id: task.propertyId },
          data: { isVerifiedByAgent: true, verificationType: 'EXPRESS_PAID', verifiedAt: now },
        });
      }
    });

    const managers = await this.managerIds(task.propertyId);
    await this.notifications?.notifyMany(managers, 'VISIT_DONE', {
      propertyId: task.propertyId,
      propertyTitle: task.property.title,
      conforming: dto.conforming,
    });
    return { conforming: dto.conforming };
  }

  // --- Communs ----------------------------------------------------------

  private async detailRow(taskId: string): Promise<TaskRow> {
    const row = await this.prisma.verificationTask.findUnique({
      where: { id: taskId },
      include: {
        agent: { select: { id: true, fullName: true } },
        property: { select: { id: true, title: true, city: true, quarter: true } },
      },
    });
    if (!row) throw new NotFoundException('Visite introuvable.');
    return row as unknown as TaskRow;
  }

  /** De quoi trouver le logement et joindre son gérant le jour de la visite. */
  private async siteInfo(row: TaskRow) {
    const [property, manager] = await Promise.all([
      this.prisma.property.findUnique({ where: { id: row.propertyId }, select: { latitude: true, longitude: true, region: true } }),
      this.prisma.propertyCollaborator.findFirst({
        where: { propertyId: row.propertyId, role: 'MANAGER' },
        include: { user: { select: { fullName: true, phone: true } } },
      }),
    ]);
    return {
      site: property ? { latitude: property.latitude, longitude: property.longitude, region: property.region } : null,
      manager: manager ? { fullName: manager.user.fullName, phone: manager.user.phone } : null,
    };
  }
}

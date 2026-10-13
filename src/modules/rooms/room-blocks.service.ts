/**
 * Blocage de dates par l'hôte. Fermer des dates ne doit jamais créer de double réservation : on refuse
 * tout blocage qui chevaucherait des séjours déjà réservés (il faut d'abord annuler ceux-là).
 */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { BLOCKING_STATUSES, peakOccupancy, type Stay } from './availability.utils.js';
import { addDays, blockAsStay, calendarDays, isoDay, MAX_BLOCK_DAYS, parseDay } from './blocks.utils.js';
import type { CreateRoomBlockDto } from './dto/room-block.dto.js';

const MAX_CALENDAR_DAYS = 62;

@Injectable()
export class RoomBlocksService {
  constructor(private readonly prisma: PrismaService) {}

  private async room(propertyId: string, roomId: string) {
    const room = await this.prisma.room.findFirst({ where: { id: roomId, propertyId }, select: { id: true, name: true, unitCount: true } });
    if (!room) throw new NotFoundException('Chambre introuvable.');
    return room;
  }

  private today(): Date {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }

  /** Blocages en cours ou à venir ; `endDate` est renvoyé comme DERNIER jour fermé (inclus), plus naturel pour l'hôte. */
  async list(propertyId: string, roomId: string) {
    await this.room(propertyId, roomId);
    const blocks = await this.prisma.roomBlock.findMany({
      where: { roomId, endDate: { gt: this.today() } },
      orderBy: { startDate: 'asc' },
      take: 200,
    });
    return blocks.map((b) => ({ id: b.id, startDate: isoDay(b.startDate), endDate: isoDay(addDays(b.endDate, -1)), units: b.units, reason: b.reason }));
  }

  /** Occupation jour par jour (réservations + fermetures) pour dessiner le calendrier. */
  async calendar(propertyId: string, roomId: string, fromRaw: string | undefined, daysRaw: string | undefined) {
    const room = await this.room(propertyId, roomId);
    const from = (fromRaw && parseDay(fromRaw)) || this.today();
    const days = Math.min(Math.max(Math.trunc(Number(daysRaw ?? 31)) || 31, 1), MAX_CALENDAR_DAYS);
    const to = addDays(from, days);
    const [stays, naps, blocks] = await Promise.all([
      this.prisma.booking.findMany({
        where: { roomId, status: { in: [...BLOCKING_STATUSES] }, napStartHour: null, checkInDate: { lt: to }, checkOutDate: { gt: from } },
        select: { checkInDate: true, checkOutDate: true, units: true },
      }),
      this.prisma.booking.findMany({
        where: { roomId, status: { in: [...BLOCKING_STATUSES] }, napStartHour: { not: null }, checkInDate: { gte: from, lt: to } },
        select: { checkInDate: true, units: true },
      }),
      this.prisma.roomBlock.findMany({ where: { roomId, startDate: { lt: to }, endDate: { gt: from } } }),
    ]);
    const napStays: Stay[] = naps.map((n) => ({ checkInDate: n.checkInDate, checkOutDate: addDays(n.checkInDate, 1), units: n.units ?? 1 }));
    return { unitCount: room.unitCount, days: calendarDays(room.unitCount, [...stays, ...napStays], blocks, from, days) };
  }

  async create(propertyId: string, roomId: string, userId: string, dto: CreateRoomBlockDto) {
    const room = await this.room(propertyId, roomId);
    const start = parseDay(dto.startDate);
    const last = parseDay(dto.endDate);
    if (!start || !last) throw new BadRequestException('Dates invalides.');
    if (last.getTime() < start.getTime()) throw new BadRequestException('Le dernier jour fermé ne peut pas précéder le premier.');
    if (start.getTime() < this.today().getTime()) throw new BadRequestException('Vous ne pouvez pas fermer des dates passées.');
    const end = addDays(last, 1);
    if ((end.getTime() - start.getTime()) / 86_400_000 > MAX_BLOCK_DAYS) {
      throw new BadRequestException('Un blocage ne peut pas dépasser un an. Pour une fermeture plus longue, suspendez le logement.');
    }
    const units = dto.units ?? null;
    if (units !== null && units > room.unitCount) {
      throw new BadRequestException(`Ce type de chambre n'a que ${room.unitCount} unité${room.unitCount > 1 ? 's' : ''}.`);
    }
    const closed = units ?? room.unitCount;

    // Séjours, siestes et autres blocages déjà là : on ne ferme pas ce qui est déjà occupé.
    const [stays, naps, others] = await Promise.all([
      this.prisma.booking.findMany({
        where: { roomId, status: { in: [...BLOCKING_STATUSES] }, napStartHour: null, checkInDate: { lt: end }, checkOutDate: { gt: start } },
        select: { checkInDate: true, checkOutDate: true, units: true },
      }),
      this.prisma.booking.findMany({
        where: { roomId, status: { in: [...BLOCKING_STATUSES] }, napStartHour: { not: null }, checkInDate: { gte: start, lt: end } },
        select: { checkInDate: true, units: true },
      }),
      this.prisma.roomBlock.findMany({ where: { roomId, startDate: { lt: end }, endDate: { gt: start } } }),
    ]);
    const occupied: Stay[] = [
      ...stays,
      ...naps.map((n) => ({ checkInDate: n.checkInDate, checkOutDate: addDays(n.checkInDate, 1), units: n.units ?? 1 })),
      ...others.map((b) => blockAsStay(b, room.unitCount)),
    ];
    const peak = peakOccupancy(occupied, start, end);
    if (peak + closed > room.unitCount) {
      throw new ConflictException(
        stays.length + naps.length > 0
          ? 'Des réservations existent déjà sur ces dates : annulez-les d’abord, ou choisissez d’autres dates.'
          : 'Ces dates sont déjà fermées pour tout ou partie des unités.',
      );
    }

    const block = await this.prisma.roomBlock.create({
      data: { roomId, startDate: start, endDate: end, units, reason: dto.reason?.slice(0, 120) || null, createdById: userId },
    });
    return { id: block.id, startDate: isoDay(block.startDate), endDate: isoDay(last), units: block.units, reason: block.reason };
  }

  async remove(propertyId: string, roomId: string, blockId: string) {
    await this.room(propertyId, roomId);
    const res = await this.prisma.roomBlock.deleteMany({ where: { id: blockId, roomId } });
    if (res.count === 0) throw new NotFoundException('Blocage introuvable.');
  }
}

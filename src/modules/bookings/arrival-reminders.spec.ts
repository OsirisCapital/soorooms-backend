import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import { ArrivalRemindersController, secretMatches } from './arrival-reminders.controller.js';
import { ArrivalRemindersService } from './arrival-reminders.service.js';
import { arrivalLabel, isReminderDue } from './arrival-reminders.js';

// Arrivée le 18/10/2026 : 14 h au Cameroun (UTC+1) = 13 h UTC.
const checkIn = new Date('2026-10-18T00:00:00Z');

describe('isReminderDue', () => {
  it("rappelle un séjour dans les 24 h avant l'arrivée, pas avant, pas après", () => {
    expect(isReminderDue('NIGHT', checkIn, null, new Date('2026-10-17T14:00:00Z'))).toBe(true);
    expect(isReminderDue('NIGHT', checkIn, null, new Date('2026-10-17T12:00:00Z'))).toBe(false); // > 24 h
    expect(isReminderDue('NIGHT', checkIn, null, new Date('2026-10-18T14:00:00Z'))).toBe(false); // arrivée passée
  });

  it('rappelle une sieste 3 h avant son début', () => {
    // sieste à 15 h Cameroun = 14 h UTC
    expect(isReminderDue('NAP', checkIn, 15, new Date('2026-10-18T12:00:00Z'))).toBe(true);
    expect(isReminderDue('NAP', checkIn, 15, new Date('2026-10-18T09:00:00Z'))).toBe(false);
  });
});

describe('arrivalLabel', () => {
  it('dit « demain », « aujourd\'hui » ou la date, avec l\'heure du Cameroun', () => {
    expect(arrivalLabel('NIGHT', checkIn, null, new Date('2026-10-17T15:00:00Z'))).toBe('demain à 14 h');
    expect(arrivalLabel('NIGHT', checkIn, null, new Date('2026-10-18T07:00:00Z'))).toBe("aujourd'hui à 14 h");
    expect(arrivalLabel('NIGHT', checkIn, null, new Date('2026-10-15T07:00:00Z'))).toBe('le 18/10/2026 à 14 h');
    expect(arrivalLabel('NAP', checkIn, 15, new Date('2026-10-18T09:00:00Z'))).toBe("aujourd'hui à 15 h");
  });
  it("n'invente pas d'heure pour une salle de fêtes", () => {
    expect(arrivalLabel('HALL', checkIn, null, new Date('2026-10-17T10:00:00Z'))).toBe('demain');
  });
});

describe('ArrivalRemindersService.run', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  function make(updateCount = 1) {
    const booking = {
      id: 'b1',
      travelerId: 't1',
      checkInDate: checkIn,
      napStartHour: null,
      traveler: { fullName: 'Marie Kouam' },
      room: { property: { title: 'Villa', propertyType: 'HOTEL', collaborators: [{ userId: 'h1', role: 'MANAGER' }] } },
    };
    const prisma = { booking: { findMany: vi.fn().mockResolvedValue([booking]), updateMany: vi.fn().mockResolvedValue({ count: updateCount }) } };
    const notify = vi.fn().mockResolvedValue(true);
    const service = new ArrivalRemindersService(prisma as unknown as PrismaService, { notify } as unknown as NotificationsService);
    return { service, prisma, notify };
  }

  it('prévient le voyageur et le gérant, une seule fois', async () => {
    const { service, prisma, notify } = make();
    expect(await service.run(new Date('2026-10-17T15:00:00Z'))).toEqual({ reminded: 1 });
    expect(prisma.booking.updateMany).toHaveBeenCalledWith({ where: { id: 'b1', arrivalReminderSentAt: null }, data: { arrivalReminderSentAt: expect.any(Date) } });
    expect(notify).toHaveBeenCalledWith('t1', 'ARRIVAL_REMINDER', expect.objectContaining({ audience: 'traveler', when: 'demain à 14 h' }));
    expect(notify).toHaveBeenCalledWith('h1', 'ARRIVAL_REMINDER', expect.objectContaining({ audience: 'host', otherName: 'Marie Kouam' }));
  });

  it("n'envoie rien si un autre appel a déjà réclamé la réservation", async () => {
    const { service, notify } = make(0);
    expect(await service.run(new Date('2026-10-17T15:00:00Z'))).toEqual({ reminded: 0 });
    expect(notify).not.toHaveBeenCalled();
  });

  it("n'envoie rien si l'arrivée est trop loin", async () => {
    const { service, prisma, notify } = make();
    expect(await service.run(new Date('2026-10-16T08:00:00Z'))).toEqual({ reminded: 0 });
    expect(prisma.booking.updateMany).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('ArrivalRemindersController', () => {
  const make = (secret: string) => {
    const run = vi.fn().mockResolvedValue({ reminded: 2 });
    const controller = new ArrivalRemindersController({ run } as unknown as ArrivalRemindersService, { get: () => secret } as unknown as ConfigService<never, true>);
    return { controller, run };
  };

  it('compare le secret sans fuite de temps', () => {
    expect(secretMatches('abc', 'abc')).toBe(true);
    expect(secretMatches('abd', 'abc')).toBe(false);
    expect(secretMatches('ab', 'abc')).toBe(false);
    expect(secretMatches(undefined, 'abc')).toBe(false);
  });

  it("n'existe pas sans CRON_SECRET, refuse un mauvais secret, accepte le bon", async () => {
    expect(() => make('').controller.run('x')).toThrow(/Not Found/);
    expect(() => make('s3cret').controller.run('nope')).toThrow(/Unauthorized/);
    const { controller, run } = make('s3cret');
    expect(await controller.run('s3cret')).toEqual({ reminded: 2 });
    expect(run).toHaveBeenCalled();
  });
});

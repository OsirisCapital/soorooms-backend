import { Controller, Headers, HttpCode, HttpStatus, NotFoundException, Post, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import { timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../../config/configuration.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { ArrivalRemindersService } from './arrival-reminders.service.js';

/** Comparaison en temps constant : le secret ne se devine pas par mesure du temps de réponse. */
export function secretMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Appelé par une tâche planifiée externe (cron-job.org, GitHub Actions…) toutes les 30 minutes, avec
 * l'en-tête `x-cron-secret`. Sans CRON_SECRET configuré, la route n'existe pas.
 */
@Public()
@SkipThrottle()
@Controller('internal/reminders')
export class ArrivalRemindersController {
  constructor(
    private readonly reminders: ArrivalRemindersService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('run')
  run(@Headers('x-cron-secret') secret: string | undefined) {
    const expected = this.config.get('cronSecret', { infer: true });
    if (!expected) throw new NotFoundException();
    if (!secretMatches(secret, expected)) throw new UnauthorizedException();
    return this.reminders.run();
  }
}

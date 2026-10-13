/**
 * Dates fermées par l'hôte. Un blocage se comporte comme un séjour qui occupe `units` unités (ou tout le type)
 * sur les nuits [startDate, endDate) : c'est ce qui le fait respecter par la recherche, la réservation et le
 * contrôle de double réservation, sans second mécanisme. Fonctions pures.
 */
import type { Stay } from './availability.utils.js';

const DAY_MS = 24 * 3_600_000;
/** Un blocage ne dépasse pas un an : au-delà, c'est le logement qu'il faut suspendre. */
export const MAX_BLOCK_DAYS = 366;

export type Block = { startDate: Date; endDate: Date; units: number | null };

/** Le blocage vu comme un séjour (pour unitsLeft / peakOccupancy). */
export function blockAsStay(block: Block, unitCount: number): Stay {
  return { checkInDate: block.startDate, checkOutDate: block.endDate, units: Math.min(block.units ?? unitCount, unitCount) };
}

/** Unités fermées une date donnée (toute la journée, sieste comprise). */
export function blockedUnitsOn(blocks: readonly Block[], date: Date, unitCount: number): number {
  const t = date.getTime();
  let blocked = 0;
  for (const b of blocks) if (b.startDate.getTime() <= t && t < b.endDate.getTime()) blocked += b.units ?? unitCount;
  return Math.min(blocked, unitCount);
}

export const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** « 2026-10-20 » → minuit UTC, ou null si la date n'existe pas. */
export function parseDay(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || isoDay(d) !== value ? null : d;
}

export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY_MS);

export type CalendarDay = { date: string; booked: number; blocked: number; free: number };

/**
 * Une ligne par jour de [from, from + days) : unités réservées, unités fermées, unités libres.
 * Les réservations de séjour occupent leurs nuits ; une sieste occupe une unité le jour où elle a lieu.
 */
export function calendarDays(
  unitCount: number,
  stays: readonly Stay[],
  blocks: readonly Block[],
  from: Date,
  days: number,
): CalendarDay[] {
  const out: CalendarDay[] = [];
  for (let i = 0; i < Math.min(days, 62); i += 1) {
    const day = addDays(from, i);
    const t = day.getTime();
    let booked = 0;
    for (const s of stays) if (s.checkInDate.getTime() <= t && t < s.checkOutDate.getTime()) booked += s.units ?? 1;
    const blocked = blockedUnitsOn(blocks, day, unitCount);
    out.push({ date: isoDay(day), booked: Math.min(booked, unitCount), blocked, free: Math.max(0, unitCount - booked - blocked) });
  }
  return out;
}

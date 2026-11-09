/**
 * Times and dates as GTFS uses them.
 *
 * A GTFS time is "seconds after noon minus 12 hours" of the service day, written HH:MM:SS, and
 * it can go past 24:00:00: a trip that leaves at 23:50 and arrives at 00:20 the next morning
 * still belongs to the first day and is written 24:20:00. Inside this project every time is a
 * number of seconds since midnight of the *query* date, which can be negative (a trip from the
 * day before) or above 86 400.
 */

export const DAY = 24 * 60 * 60;

export class TimeError extends Error {}

/** "8:05:00" or "25:10:00" -> seconds. Hours may have one or two (or more) digits. */
export function parseTime(text: string): number {
  const match = /^\s*(\d+):([0-5]\d):([0-5]\d)\s*$/.exec(text);
  if (!match) throw new TimeError(`not a GTFS time: "${text}"`);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/** "08:05" or "8:05" (or with seconds) for the command line -> seconds. */
export function parseClock(text: string): number {
  const match = /^\s*(\d{1,2}):([0-5]\d)(?::([0-5]\d))?\s*$/.exec(text);
  if (!match || Number(match[1]) > 47) throw new TimeError(`not a time: "${text}" (use HH:MM)`);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] ?? 0);
}

/** Seconds -> "08:05", with "+1" for the next day (and "-1" for the previous one). */
export function formatClock(seconds: number): string {
  const days = Math.floor(seconds / DAY);
  const rest = seconds - days * DAY;
  const h = Math.floor(rest / 3600);
  const m = Math.floor((rest % 3600) / 60);
  const clock = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  return days === 0 ? clock : `${clock} (${days > 0 ? "+" : ""}${days})`;
}

/** A calendar date without a time zone: GTFS service days are local dates. */
export interface ServiceDate {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number;
}

/** "2026-11-10" (command line) or "20261110" (GTFS) -> date. */
export function parseDate(text: string): ServiceDate {
  const match = /^\s*(\d{4})-?(\d{2})-?(\d{2})\s*$/.exec(text);
  if (!match) throw new TimeError(`not a date: "${text}" (use YYYY-MM-DD)`);
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const check = new Date(Date.UTC(date.year, date.month - 1, date.day));
  if (check.getUTCMonth() !== date.month - 1 || check.getUTCDate() !== date.day) {
    throw new TimeError(`no such date: "${text}"`);
  }
  return date;
}

/** YYYYMMDD as a number, for comparing with calendar.txt ranges. */
export function dateKey(date: ServiceDate): number {
  return date.year * 10000 + date.month * 100 + date.day;
}

export function addDays(date: ServiceDate, days: number): ServiceDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** 0 = Monday ... 6 = Sunday, the order of the weekday columns in calendar.txt. */
export function weekday(date: ServiceDate): number {
  return (new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() + 6) % 7;
}

export function formatDate(date: ServiceDate): string {
  return `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

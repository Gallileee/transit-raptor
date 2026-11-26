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

/**
 * Whole minutes from one time to another as the clock shows them: 08:01:50 -> 08:12:10 is
 * 11 minutes, because they read "08:01" and "08:12". Rounding the seconds (10.3 -> 10) would
 * contradict the two times printed next to it.
 */
export function minutesBetween(from: number, to: number): number {
  return Math.floor(to / 60) - Math.floor(from / 60);
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

/*
 * Time zones. A feed's times are local to agency.txt's agency_timezone, whatever zone the
 * machine running this is in. A service day starts at "noon minus 12 hours": on the two
 * daylight-saving days that is 23:00 or 01:00 by the clock, not midnight.
 */

/** The zone this machine is set to, for feeds that don't name one. */
export function localZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Whether `name` is an IANA time zone this runtime knows ("Europe/Prague"). */
export function isTimeZone(name: string): boolean {
  if (!name.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The date and the seconds since midnight that a clock in `zone` shows at an instant. */
function clockIn(ms: number, zone: string): { date: ServiceDate; seconds: number } {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, formatter);
  }
  const part: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
  for (const p of formatter.formatToParts(ms)) if (p.type !== "literal") part[p.type] = Number(p.value);
  return {
    date: { year: part.year!, month: part.month!, day: part.day! },
    seconds: part.hour! * 3600 + part.minute! * 60 + part.second!,
  };
}

/** How far `zone`'s clocks are ahead of UTC at an instant, in seconds (Prague: 3600 or 7200). */
export function zoneOffset(ms: number, zone: string): number {
  const { date, seconds } = clockIn(ms, zone);
  const asUtc = Date.UTC(date.year, date.month - 1, date.day) + seconds * 1000;
  return (asUtc - Math.floor(ms / 1000) * 1000) / 1000;
}

/** The date a clock in `zone` shows at an instant. */
export function dateIn(instant: Date, zone: string): ServiceDate {
  return clockIn(instant.getTime(), zone).date;
}

/**
 * When a service day starts (its 00:00:00 in GTFS terms), as epoch milliseconds: noon in `zone`
 * minus 12 hours. Noon is never skipped or repeated by a clock change, so it is found by
 * correcting a guess with the offset at noon.
 */
export function serviceDayStart(date: ServiceDate, zone: string): number {
  const noonUtc = Date.UTC(date.year, date.month - 1, date.day, 12);
  let noon = noonUtc - zoneOffset(noonUtc, zone) * 1000;
  noon = noonUtc - zoneOffset(noon, zone) * 1000;
  return noon - 12 * 3600 * 1000;
}

/** An instant as seconds of `date`'s service day (negative before it, above 86 400 after). */
export function serviceSeconds(instant: Date, date: ServiceDate, zone: string): number {
  return Math.floor((instant.getTime() - serviceDayStart(date, zone)) / 1000);
}

/** The instant a time of `date`'s service day is. */
export function instantOf(date: ServiceDate, seconds: number, zone: string): Date {
  return new Date(serviceDayStart(date, zone) + seconds * 1000);
}

/**
 * A time of `date`'s service day as `zone`'s clock reads it, "2026-11-10T08:05:00": the form
 * Golemio's timeFrom takes. 24:20:00 is the next day's 00:20.
 */
export function wallClock(date: ServiceDate, seconds: number, zone: string): string {
  const clock = clockIn(serviceDayStart(date, zone) + seconds * 1000, zone);
  const s = clock.seconds;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${formatDate(clock.date)}T${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

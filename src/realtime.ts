/**
 * Live delays for the departures board, from Golemio, the Prague data platform that publishes
 * PID's real-time data: GET /v2/pid/departureboards
 * (docs: https://api.golemio.cz/pid/docs/openapi/).
 *
 * It needs an API key (free, from https://api.golemio.cz/api-keys). The key is read from the
 * environment by the caller (GOLEMIO_API_KEY), sent only in the X-Access-Token header to
 * Golemio, and never logged, put in a URL or passed to the page. Without a key there are simply
 * no live delays.
 *
 * Golemio answers with GTFS trip and stop ids, the same as PID's feed, so departures are
 * matched by trip and stop. A key may make 20 requests in 8 seconds, so answers are kept for
 * CACHE_MS and identical requests in flight share one call.
 *
 * Golemio answers at most 100 departures, whatever `limit` asks (at Anděl that is ~37 minutes
 * of an hour), so a longer answer is asked for in pages: each from the last one's last
 * scheduled time. Its window goes by when vehicles are expected but its order by the
 * timetable (a page from 12:07 had a late vehicle of 11:56), so pages overlap by
 * PAGE_OVERLAP minutes, for vehicles running early, and run a minute past the end.
 */

/** What the vehicle is doing on one departure, as far as Golemio knows. */
export interface LiveDeparture {
  /**
   * Seconds late, or null when the vehicle doesn't report. Never negative: Golemio reports a
   * vehicle that is ahead, or waiting at its first stop, as early (R19 at Praha hl.n.: -3 min,
   * IDOS "no delay"), but PID's vehicles don't leave before their time.
   */
  readonly delay: number | null;
  readonly canceled: boolean;
  /** The vehicle is at the stop now. */
  readonly atStop: boolean;
  /**
   * The platform it leaves from, as Golemio knows it: for trains the track they are given on
   * the day ("4J": track 4, south part), null until then; for the rest the timetable's code.
   */
  readonly platform: string | null;
}

export interface LiveQuery {
  /** GTFS stop ids (every platform of the stop). */
  readonly stopIds: readonly string[];
  /** The board's time, Prague time: "2026-11-16T08:00:00". */
  readonly from: string;
  /** Minutes before it (late vehicles scheduled earlier) and after it. */
  readonly before: number;
  readonly minutes: number;
  /** At most this many departures (more than PAGE: asked for in pages, at most MAX_PAGES). */
  readonly limit: number;
}

/** A source of live delays. `departures` maps `trip id|stop id` to what is known. */
export interface Realtime {
  departures(query: LiveQuery): Promise<Map<string, LiveDeparture>>;
}

export class RealtimeError extends Error {}

export const liveKey = (tripId: string, stopId: string) => `${tripId}|${stopId}`;

const CACHE_MS = 20_000;
/** The most departures Golemio gives in one answer. */
export const PAGE = 100;
/** Pages for one query, at most: 500 departures, 5 of the 20 requests the key may make in 8 s. */
export const MAX_PAGES = 5;
/** Minutes each page after the first goes back before the last one's last scheduled time. */
const PAGE_OVERLAP = 5;

export interface GolemioOptions {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

interface GolemioDeparture {
  delay?: { is_available?: boolean; seconds?: number | null } | null;
  stop?: { id?: string; platform_code?: string | null } | null;
  trip?: { id?: string; is_canceled?: boolean; is_at_stop?: boolean } | null;
  departure_timestamp?: { scheduled?: string | null } | null;
}

/** "2026-11-16T12:07:00" (Prague time, as Golemio's timeFrom) plus minutes. */
function addMinutes(time: string, minutes: number): string {
  return new Date(Date.parse(`${time}Z`) + minutes * 60_000).toISOString().slice(0, 19);
}

/** Whole minutes from one such time to another, rounded up. */
function minutesUntil(from: string, to: string): number {
  return Math.ceil((Date.parse(`${to}Z`) - Date.parse(`${from}Z`)) / 60_000);
}

/** A scheduled time as Golemio gives it ("2026-11-16T12:07:00+01:00") in the timeFrom form. */
function localTime(stamp: string | null | undefined): string | undefined {
  return typeof stamp === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(stamp) ? stamp.slice(0, 19) : undefined;
}

export class GolemioRealtime implements Realtime {
  private readonly cache = new Map<string, { at: number; answer: Promise<Map<string, LiveDeparture>> }>();
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;

  constructor(
    private readonly key: string,
    options: GolemioOptions = {},
  ) {
    this.baseUrl = options.baseUrl ?? "https://api.golemio.cz";
    this.timeoutMs = options.timeoutMs ?? 4000;
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  departures(query: LiveQuery): Promise<Map<string, LiveDeparture>> {
    const url = this.url(query.stopIds, query.from, query.before, query.minutes, Math.min(query.limit, PAGE));
    const key = `${url}#${query.limit}`;
    const now = this.now();
    for (const [k, entry] of this.cache) if (now - entry.at > CACHE_MS) this.cache.delete(k);
    const cached = this.cache.get(key);
    if (cached) return cached.answer;
    const answer = this.pages(query, url);
    this.cache.set(key, { at: now, answer });
    answer.catch(() => this.cache.delete(key)); // a failure isn't kept
    return answer;
  }

  private url(stopIds: readonly string[], from: string, before: number, minutes: number, limit: number): string {
    const params = new URLSearchParams();
    for (const id of [...stopIds].sort()) params.append("ids", id);
    params.set("timeFrom", from);
    params.set("minutesBefore", String(before));
    params.set("minutesAfter", String(minutes));
    params.set("limit", String(limit));
    params.set("mode", "departures");
    params.set("order", "timetable");
    return `${this.baseUrl}/v2/pid/departureboards?${params}`;
  }

  /** The first page, and while a page is full and more are wanted, the next ones. */
  private async pages(query: LiveQuery, first: string): Promise<Map<string, LiveDeparture>> {
    const live = new Map<string, LiveDeparture>();
    const end = addMinutes(query.from, query.minutes);
    let url = first;
    let previous: string | undefined;
    for (let page = 1; ; page++) {
      const { departures, count, last } = await this.ask(url);
      for (const [key, known] of departures) if (!live.has(key)) live.set(key, known);
      if (count < PAGE || live.size >= query.limit || page >= MAX_PAGES) break;
      // Stop when the pages don't move on (a page all of one minute) or the window is done.
      if (!last || (previous !== undefined && last <= previous) || last >= end) break;
      previous = last;
      const from = addMinutes(last, -PAGE_OVERLAP);
      url = this.url(query.stopIds, from, 0, minutesUntil(from, end) + 1, PAGE);
    }
    return live;
  }

  private async ask(url: string): Promise<{ departures: Map<string, LiveDeparture>; count: number; last: string | undefined }> {
    let response: Response;
    try {
      response = await this.fetch(url, {
        headers: { "X-Access-Token": this.key, Accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new RealtimeError(e instanceof Error && e.name === "TimeoutError" ? "no answer in time" : "can't be reached");
    }
    if (!response.ok) {
      throw new RealtimeError(response.status === 401 ? "the API key was refused (401)" : `HTTP ${response.status}`);
    }
    let body: { departures?: GolemioDeparture[] };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      throw new RealtimeError("not JSON");
    }
    const live = new Map<string, LiveDeparture>();
    let last: string | undefined;
    for (const d of body.departures ?? []) {
      last = localTime(d.departure_timestamp?.scheduled) ?? last;
      const tripId = d.trip?.id;
      const stopId = d.stop?.id;
      if (!tripId || !stopId) continue;
      const seconds = d.delay?.is_available ? d.delay.seconds : null;
      live.set(liveKey(tripId, stopId), {
        delay: typeof seconds === "number" && Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : null,
        canceled: d.trip?.is_canceled === true,
        atStop: d.trip?.is_at_stop === true,
        platform: typeof d.stop?.platform_code === "string" && d.stop.platform_code.trim() ? d.stop.platform_code.trim() : null,
      });
    }
    return { departures: live, count: body.departures?.length ?? 0, last };
  }
}

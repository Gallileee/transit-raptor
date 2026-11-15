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
  readonly limit: number;
}

/** A source of live delays. `departures` maps `trip id|stop id` to what is known. */
export interface Realtime {
  departures(query: LiveQuery): Promise<Map<string, LiveDeparture>>;
}

export class RealtimeError extends Error {}

export const liveKey = (tripId: string, stopId: string) => `${tripId}|${stopId}`;

const CACHE_MS = 20_000;

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
    const params = new URLSearchParams();
    for (const id of [...query.stopIds].sort()) params.append("ids", id);
    params.set("timeFrom", query.from);
    params.set("minutesBefore", String(query.before));
    params.set("minutesAfter", String(query.minutes));
    params.set("limit", String(query.limit));
    params.set("mode", "departures");
    params.set("order", "timetable");
    const url = `${this.baseUrl}/v2/pid/departureboards?${params}`;

    const now = this.now();
    for (const [key, entry] of this.cache) if (now - entry.at > CACHE_MS) this.cache.delete(key);
    const cached = this.cache.get(url);
    if (cached) return cached.answer;
    const answer = this.ask(url);
    this.cache.set(url, { at: now, answer });
    answer.catch(() => this.cache.delete(url)); // a failure isn't kept
    return answer;
  }

  private async ask(url: string): Promise<Map<string, LiveDeparture>> {
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
    for (const d of body.departures ?? []) {
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
    return live;
  }
}

/**
 * Planning as a service: the timetable of a date is loaded once and reused, and journeys are
 * turned into plain JSON (names, times, colours, coordinates) for the web page.
 */
import { fingerprint, type OpenedFeed, openFeed } from "./cache.js";
import { type Access, coveredDates, type Feed, feedForDate } from "./gtfs.js";
import { earliestTrip, type Journey, type Leg, plan, profile } from "./raptor.js";
import { type LiveDeparture, liveKey, type Realtime, RealtimeError } from "./realtime.js";
import { cut, type LatLon, type Shapes } from "./shapes.js";
import { StopIndex, type StopMatch } from "./stops.js";
import { formatClock, formatDate, minutesBetween, parseClock, parseDate, type ServiceDate } from "./time.js";
import { buildTimetable, departure as departureAt, type Timetable, viaStreet } from "./timetable.js";

/** Something the caller got wrong (an unknown stop, a malformed time): HTTP 400, not 500. */
export class RequestError extends Error {
  constructor(
    message: string,
    readonly suggestions: string[] = [],
  ) {
    super(message);
  }
}

export interface Loaded {
  readonly feed: Feed;
  readonly timetable: Timetable;
  /** Built on first use (about 0.3 s for Prague) and then kept with the date. */
  readonly stepFreeTimetable: () => Timetable;
  readonly index: StopIndex;
  readonly tripById: Map<string, Feed["trips"][number]>;
  /** Street geometry; shared by all dates (shapes don't change from day to day). */
  readonly shapes: Shapes;
  /** Which timetable this is: the same for every date loaded from one feed. */
  readonly info: FeedInfo;
}

/** The timetable in use, for the page: the dates it covers and when the server loaded it. */
export interface FeedInfo {
  /**
   * The dates it covers, YYYY-MM-DD: feed_info.txt's feed_start_date and feed_end_date, or the
   * first and last date with service when it doesn't say. Empty when neither is known.
   */
  firstDate: string;
  lastDate: string;
  /** When this server loaded the feed (ISO 8601, UTC); a reload changes it. */
  loadedAt: string;
}

/** One FeedInfo per opened feed, made when the first date is loaded from it. */
const infos = new WeakMap<OpenedFeed, FeedInfo>();

function feedInfo(opened: OpenedFeed, now: Date): FeedInfo {
  let info = infos.get(opened);
  if (!info) {
    const range = coveredDates(opened.compiled);
    info = {
      firstDate: range ? formatDate(range.first) : "",
      lastDate: range ? formatDate(range.last) : "",
      loadedAt: now.toISOString(),
    };
    infos.set(opened, info);
  }
  return info;
}

const MODES: Record<number, string> = {
  0: "tram",
  1: "metro",
  2: "train",
  3: "bus",
  4: "ferry",
  5: "cable car",
  6: "aerial lift",
  7: "funicular",
  11: "trolleybus",
  12: "monorail",
};

export interface StopJson {
  name: string;
  platform: string;
  lat: number;
  lon: number;
}

export interface PassedStop extends StopJson {
  arrival: string;
}

export type LegJson =
  | {
      kind: "ride";
      mode: string;
      line: string;
      color: string;
      textColor: string;
      headsign: string;
      from: StopJson;
      to: StopJson;
      departure: string;
      arrival: string;
      stops: number;
      /**
       * Step-free: "yes" when the vehicle and both stops are marked accessible, "no" when one of
       * them is marked not accessible, "unknown" otherwise (most street stops in PID).
       */
      access: "yes" | "no" | "unknown";
      /**
       * The line to draw: along the street from shapes.txt when the trip has a shape that fits
       * its stops ("shape": true), otherwise straight between the stops passed.
       */
      path: LatLon[];
      shape: boolean;
      /**
       * The stops between getting on and off where the vehicle stops, with its arrival time,
       * for dots on the map. Stops it only passes (no pickup and no drop-off) aren't listed.
       */
      passed: PassedStop[];
    }
  | {
      kind: "walk";
      from: StopJson;
      to: StopJson;
      departure: string;
      arrival: string;
      minutes: number;
      path: [number, number][];
      /**
       * A change inside a station that goes out to the street and back in through another
       * entrance: in a step-free search at Muzeum, the lifts from A and from C only reach the street.
       */
      street: boolean;
    };

export interface JourneyJson {
  departure: string;
  arrival: string;
  minutes: number;
  transfers: number;
  legs: LegJson[];
}

export interface PlanRequest {
  from: string;
  to: string;
  date?: string | undefined;
  time?: string | undefined;
  /** Minutes. */
  window?: number | undefined;
  maxTransfers?: number | undefined;
  list?: boolean | undefined;
  /** Only journeys usable with a wheelchair (no stairs, escalators or inaccessible vehicles). */
  stepFree?: boolean | undefined;
}

export interface PlanResponse {
  from: string;
  to: string;
  date: string;
  time: string;
  stepFree: boolean;
  journeys: JourneyJson[];
  /** The timetable that answered: after a reload the page sees the new one. */
  feed: FeedInfo;
}

export interface DeparturesRequest {
  stop: string;
  date?: string | undefined;
  time?: string | undefined;
  /** At most this many departures (default 20, 1-100). */
  limit?: number | undefined;
  /** Only departures within this many minutes (default 120, 1-1440). */
  window?: number | undefined;
}

export interface DepartureJson {
  /** HH:MM; "+1" style suffix after midnight, as in journeys. */
  departure: string;
  /** From the request time to the timetable's time, counted the way a clock shows it. */
  minutes: number;
  /** The same to when it is expected to leave: with the live delay, if there is one. */
  expectedMinutes: number;
  mode: string;
  line: string;
  color: string;
  textColor: string;
  headsign: string;
  /** The platform (stop) it leaves from, as in the feed's platform_code. */
  platform: string;
  /** Vehicle and stop, as for rides: "yes", "no" or "unknown". */
  access: "yes" | "no" | "unknown";
  /** Live: seconds late (negative: early), or null when not known (no live data, or no report). */
  delay: number | null;
  /** Live: the trip won't run. */
  canceled: boolean;
}

export interface DeparturesResponse {
  stop: string;
  date: string;
  time: string;
  departures: DepartureJson[];
  /**
   * Live delays: "on" (asked and answered), "off" (no source configured, or the board isn't for
   * now) or "error" (the source didn't answer; the timetable is shown as it is).
   */
  live: "on" | "off" | "error";
  feed: FeedInfo;
}

/** How far from the server's clock a board may be and still get live delays (they are for now). */
const LIVE_WITHIN = 5 * 60;
/**
 * With live delays, a board also looks this far back in the timetable: a late vehicle scheduled
 * before now is still to come. (Golemio keeps 30 minutes of the past.)
 */
const LATE_LOOKBACK = 15 * 60;

/** What `checkForNewFeed` did. */
export type ReloadResult = "unchanged" | "waiting" | "reloaded" | "failed" | "busy";

/**
 * Loads the feed once (from the cache when `cacheDir` is given and the cache is up to date),
 * and the timetables of the most recently used dates from it. `checkForNewFeed` replaces the
 * feed when its files change (a new download), without stopping requests.
 */
export class Planner {
  private readonly cache = new Map<string, Promise<Loaded>>();
  private opened: Promise<OpenedFeed> | undefined;
  /** Fingerprint of the files the feed in use was read from (taken before reading them). */
  private print: string | undefined;
  /** A changed fingerprint seen once: reloaded when the next check sees it unchanged. */
  private pending: string | undefined;
  /** A fingerprint whose files failed to load: not tried again until they change. */
  private failed: string | undefined;
  private reloading = false;
  /** Live delays for departure boards (Golemio with an API key), or none. */
  realtime: Realtime | undefined;
  private liveErrorLogged = 0;

  constructor(
    readonly gtfsDir: string,
    private readonly now: () => Date = () => new Date(),
    private readonly keep = 2,
    private readonly log: (line: string) => void = () => {},
    private readonly cacheDir: string | undefined = undefined,
  ) {}

  /** The feed for all dates, read once; a failure isn't kept, so the next request retries. */
  private open(): Promise<OpenedFeed> {
    if (!this.opened) {
      const print = fingerprint(this.gtfsDir);
      const opening = openFeed(this.gtfsDir, { cacheDir: this.cacheDir, log: this.log }).then((opened) => {
        this.print = print;
        return opened;
      });
      opening.catch(() => {
        if (this.opened === opening) this.opened = undefined;
      });
      this.opened = opening;
    }
    return this.opened;
  }

  load(date: ServiceDate): Promise<Loaded> {
    const key = formatDate(date);
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key); // re-insert: Map order is the least-recently-used order
      this.cache.set(key, cached);
      return cached;
    }
    const loading = this.open().then((opened) => {
      const { compiled, shapes } = opened;
      const feed = feedForDate(compiled, date);
      let stepFree: Timetable | undefined;
      return {
        feed,
        timetable: buildTimetable(feed),
        stepFreeTimetable: () => (stepFree ??= buildTimetable(feed, { stepFree: true })),
        index: new StopIndex(feed.stops),
        tripById: new Map(feed.trips.map((t) => [t.id, t])),
        shapes,
        info: feedInfo(opened, this.now()),
      };
    });
    loading.catch(() => {
      if (this.cache.get(key) === loading) this.cache.delete(key); // don't cache a failure
    });
    this.cache.set(key, loading);
    while (this.cache.size > this.keep) this.cache.delete(this.cache.keys().next().value!);
    return loading;
  }

  /**
   * Look at the feed's files and load them again if they changed. Meant to be called every
   * few minutes. A download replaces the files one by one, so a change is only acted on when
   * the next check finds the files as they were: then they are read in the background, and
   * swapped in once today's timetable is ready. Until then, and if reading fails, requests are
   * answered from the feed in use.
   */
  async checkForNewFeed(): Promise<ReloadResult> {
    if (this.print === undefined || this.reloading) return this.reloading ? "busy" : "unchanged";
    const now = fingerprint(this.gtfsDir);
    if (now === this.print) {
      this.pending = undefined;
      return "unchanged";
    }
    if (now === this.failed) return "failed";
    if (now !== this.pending) {
      this.pending = now;
      this.log("feed: files changed; loading them once they stop changing");
      return "waiting";
    }
    this.pending = undefined;
    this.reloading = true;
    const started = performance.now();
    try {
      const opened = await openFeed(this.gtfsDir, { cacheDir: this.cacheDir, log: this.log });
      if (fingerprint(this.gtfsDir) !== now) {
        this.log("feed: files changed again while loading; trying again later");
        return "waiting";
      }
      const fresh = new Planner(this.gtfsDir, this.now, this.keep, this.log);
      fresh.opened = Promise.resolve(opened);
      const today = fresh.today();
      const loaded = await fresh.load(today); // ready before anyone uses it
      this.opened = fresh.opened;
      this.print = now;
      this.failed = undefined;
      this.cache.clear();
      this.cache.set(formatDate(today), Promise.resolve(loaded));
      this.log(`feed: reloaded in ${Math.round(performance.now() - started)} ms`);
      return "reloaded";
    } catch (e) {
      this.failed = now;
      this.log(`feed: not reloaded (${e instanceof Error ? e.message : String(e)}); still using the previous one`);
      return "failed";
    } finally {
      this.reloading = false;
    }
  }

  today(): ServiceDate {
    const now = this.now();
    return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  }

  /** The timetable in use (opening the feed if no request has yet). */
  async feed(): Promise<FeedInfo> {
    return feedInfo(await this.open(), this.now());
  }

  /** Stop names for an autocomplete box. */
  async stops(text: string, date?: string): Promise<string[]> {
    const { index } = await this.load(date ? parseDate(date) : this.today());
    const match = index.find(text, 10);
    return match.kind === "found" ? [match.name] : match.kind === "ambiguous" ? match.names : match.suggestions;
  }

  /**
   * The next departures from every platform of a stop, from the timetable: one line per trip
   * that lets passengers on there and goes on (a trip ending there is an arrival, not listed).
   */
  async departures(request: DeparturesRequest): Promise<DeparturesResponse> {
    const date = request.date ? parseDate(request.date) : this.today();
    const now = this.now();
    const from = request.time ? parseClock(request.time) : now.getHours() * 3600 + now.getMinutes() * 60;
    const limit = request.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RequestError("limit must be a whole number from 1 to 100");
    const window = request.window ?? 120;
    if (!Number.isInteger(window) || window < 1 || window > 24 * 60) {
      throw new RequestError("window must be a whole number of minutes from 1 to 1440");
    }
    const loaded = await this.load(date);
    const stop = resolve(loaded.index, request.stop, "stop");
    const { feed, timetable } = loaded;
    const until = from + window * 60;
    const live = this.liveWanted(date, from);
    const start = live ? from - LATE_LOOKBACK : from;
    const found: { at: number; key: string; json: Omit<DepartureJson, "minutes" | "expectedMinutes" | "delay" | "canceled"> }[] = [];
    for (const s of stop.stops) {
      for (const { pattern: p, position } of timetable.stopPatterns[s]!) {
        const pattern = timetable.patterns[p]!;
        if (position === pattern.stops.length - 1 || !pattern.canBoard[position]) continue;
        const route = feed.routes.get(pattern.routeId);
        const first = earliestTrip(timetable, p, position, start);
        // Trips of a pattern don't overtake each other, so their departures here are in order.
        const most = limit + (start < from ? 30 : 0); // room for the ones looked back at
        for (let t = first; t >= 0 && t < pattern.trips.length && t < first + most; t++) {
          const at = departureAt(pattern, t, position);
          if (at > until) break;
          const trip = pattern.trips[t]!;
          found.push({
            at,
            key: liveKey(trip.id, feed.stops[s]!.id),
            json: {
              departure: formatClock(at),
              mode: route ? (MODES[route.type] ?? "line") : "line",
              line: route?.shortName || route?.longName || pattern.routeId,
              color: route?.color ?? "",
              textColor: route?.textColor ?? "",
              headsign: trip.headsign,
              platform: feed.stops[s]!.platform,
              access: combinedAccess([trip.wheelchair, feed.stops[s]!.wheelchair]),
            },
          });
        }
      }
    }
    const { known, state } = live
      ? await this.liveFor(this.realtime!, date, from, window, limit, stop.stops.map((s) => feed.stops[s]!.id))
      : { known: new Map<string, LiveDeparture>(), state: "off" as const };
    const departures = found
      .map(({ at, key, json }) => {
        const info = known.get(key);
        const delay = info?.delay ?? null;
        const expected = at + (delay ?? 0);
        return { at, expected, json: { ...json, minutes: minutesBetween(from, at), expectedMinutes: minutesBetween(from, expected), delay, canceled: info?.canceled ?? false } };
      })
      // Looked back at for late vehicles: only those still to come stay.
      .filter((d) => d.at >= from || (d.json.delay !== null && !d.json.canceled && d.expected >= from))
      .sort((a, b) => a.expected - b.expected || a.at - b.at || a.json.line.localeCompare(b.json.line));
    return {
      stop: stop.name,
      date: formatDate(date),
      time: formatClock(from),
      departures: departures.slice(0, limit).map((d) => d.json),
      live: state,
      feed: loaded.info,
    };
  }

  /** Whether a board gets live delays: a source is set and the board is for now. */
  private liveWanted(date: ServiceDate, from: number): boolean {
    if (!this.realtime) return false;
    const asked = new Date(date.year, date.month - 1, date.day, 0, 0, from);
    return Math.abs(asked.getTime() - this.now().getTime()) <= LIVE_WITHIN * 1000;
  }

  /** Live delays for a board. Never throws for the source failing. */
  private async liveFor(realtime: Realtime, date: ServiceDate, from: number, window: number, limit: number, stopIds: string[]) {
    const now = this.now();
    const clock = formatClock(from).slice(0, 5);
    try {
      const known = await realtime.departures({
        stopIds,
        from: `${formatDate(date)}T${clock}:00`,
        before: LATE_LOOKBACK / 60,
        minutes: window,
        // Golemio counts departures over all the platforms, and may order them a little
        // differently: ask for more than are shown.
        limit: Math.min(1000, limit * 3 + 30),
      });
      return { known, state: "on" as const };
    } catch (e) {
      if (!(e instanceof RealtimeError)) throw e;
      // Logged at most once a minute: a board refreshes every 30 s.
      if (now.getTime() - this.liveErrorLogged > 60_000) {
        this.liveErrorLogged = now.getTime();
        this.log(`live: no delays (${e.message}); showing the timetable`);
      }
      return { known: new Map<string, LiveDeparture>(), state: "error" as const };
    }
  }

  async plan(request: PlanRequest): Promise<PlanResponse> {
    const date = request.date ? parseDate(request.date) : this.today();
    const now = this.now();
    const departAt = request.time ? parseClock(request.time) : now.getHours() * 3600 + now.getMinutes() * 60;
    const window = request.window ?? 60;
    if (!Number.isInteger(window) || window < 0 || window > 24 * 60) {
      throw new RequestError("window must be a whole number of minutes from 0 to 1440");
    }
    const maxTransfers = request.maxTransfers ?? 4;
    if (!Number.isInteger(maxTransfers) || maxTransfers < 0 || maxTransfers > 10) {
      throw new RequestError("maxTransfers must be a whole number from 0 to 10");
    }
    const loaded = await this.load(date);
    const from = resolve(loaded.index, request.from, "from");
    const to = resolve(loaded.index, request.to, "to");
    const query = { from: from.stops, to: to.stops, departAt, maxTransfers, window: window * 60 };
    const stepFree = request.stepFree === true;
    const timetable = stepFree ? loaded.stepFreeTimetable() : loaded.timetable;
    const journeys = request.list ? profile(timetable, query) : plan(timetable, query);
    return {
      from: from.name,
      to: to.name,
      date: formatDate(date),
      time: formatClock(departAt),
      stepFree,
      journeys: journeys.map((j) => journeyJson(loaded, j, timetable)),
      feed: loaded.info,
    };
  }
}

function resolve(index: StopIndex, text: string, field: string): { name: string; stops: number[] } {
  if (!text.trim()) throw new RequestError(`${field} is required`);
  const match: StopMatch = index.find(text);
  if (match.kind === "found") return match;
  if (match.kind === "ambiguous") throw new RequestError(`${field}: "${text}" matches several stops`, match.names);
  throw new RequestError(`${field}: no stop called "${text}"`, match.suggestions);
}

function stopJson(feed: Feed, index: number): StopJson {
  const s = feed.stops[index]!;
  return { name: s.name, platform: s.platform, lat: s.lat, lon: s.lon };
}

function point(feed: Feed, index: number): LatLon {
  const s = feed.stops[index]!;
  return [s.lat, s.lon];
}

export function journeyJson(loaded: Loaded, journey: Journey, timetable: Timetable = loaded.timetable): JourneyJson {
  return {
    departure: formatClock(journey.departure),
    arrival: formatClock(journey.arrival),
    minutes: minutesBetween(journey.departure, journey.arrival),
    transfers: journey.transfers,
    legs: journey.legs.map((leg) => legJson(loaded, leg, timetable)),
  };
}

function legJson({ feed, tripById, shapes }: Loaded, leg: Leg, timetable: Timetable): LegJson {
  const times = { departure: formatClock(leg.departure), arrival: formatClock(leg.arrival) };
  if (leg.kind === "walk") {
    return {
      kind: "walk",
      from: stopJson(feed, leg.from),
      to: stopJson(feed, leg.to),
      ...times,
      minutes: Math.max(1, minutesBetween(leg.departure, leg.arrival)),
      path: [point(feed, leg.from), point(feed, leg.to)],
      street: viaStreet(timetable, leg.from, leg.to),
    };
  }
  const route = feed.routes.get(leg.routeId);
  // The stops passed: the trip's stops from where one gets on to where one gets off.
  const trip = tripById.get(leg.tripId);
  let path: LatLon[] = [point(feed, leg.from), point(feed, leg.to)];
  let shaped: LatLon[] | undefined;
  const passed: PassedStop[] = [];
  if (trip) {
    const stops = [...trip.stops];
    const start = stops.findIndex((s, i) => s === leg.from && trip.departures[i] === leg.departure);
    if (start >= 0) {
      const end = start + leg.stopCount;
      path = stops.slice(start, end + 1).map((s) => point(feed, s));
      const shape = shapes.get(trip.shapeId);
      if (shape) shaped = cut(shape, onShape(feed, trip, start), onShape(feed, trip, end));
      for (let i = start + 1; i < end; i++) {
        if (!trip.canBoard[i] && !trip.canAlight[i]) continue;
        passed.push({ ...stopJson(feed, trip.stops[i]!), arrival: formatClock(trip.arrivals[i]!) });
      }
    }
  }
  return {
    kind: "ride",
    mode: route ? (MODES[route.type] ?? "line") : "line",
    line: route?.shortName || route?.longName || leg.routeId,
    color: route?.color ?? "",
    textColor: route?.textColor ?? "",
    headsign: leg.headsign,
    from: stopJson(feed, leg.from),
    to: stopJson(feed, leg.to),
    ...times,
    stops: leg.stopCount,
    access: combinedAccess([trip?.wheelchair ?? 0, feed.stops[leg.from]!.wheelchair, feed.stops[leg.to]!.wheelchair]),
    path: shaped ?? path,
    shape: shaped !== undefined,
    passed,
  };
}

function onShape(feed: Feed, trip: Feed["trips"][number], i: number) {
  const stop = feed.stops[trip.stops[i]!]!;
  return { lat: stop.lat, lon: stop.lon, dist: trip.distances[i]! };
}

/** One "no" makes the leg not step-free; it is confirmed only when every part says yes. */
export function combinedAccess(parts: Access[]): "yes" | "no" | "unknown" {
  if (parts.includes(2)) return "no";
  return parts.every((p) => p === 1) ? "yes" : "unknown";
}


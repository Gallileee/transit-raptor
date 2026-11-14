/**
 * Planning as a service: the timetable of a date is loaded once and reused, and journeys are
 * turned into plain JSON (names, times, colours, coordinates) for the web page.
 */
import { type OpenedFeed, openFeed } from "./cache.js";
import { type Access, type Feed, feedForDate } from "./gtfs.js";
import { type Journey, type Leg, plan, profile } from "./raptor.js";
import { cut, type LatLon, type Shapes } from "./shapes.js";
import { StopIndex, type StopMatch } from "./stops.js";
import { formatClock, formatDate, parseClock, parseDate, type ServiceDate } from "./time.js";
import { buildTimetable, type Timetable } from "./timetable.js";

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
    }
  | { kind: "walk"; from: StopJson; to: StopJson; departure: string; arrival: string; minutes: number; path: [number, number][] };

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
}

/**
 * Loads the feed once (from the cache when `cacheDir` is given and the cache is up to date),
 * and the timetables of the most recently used dates from it.
 */
export class Planner {
  private readonly cache = new Map<string, Promise<Loaded>>();
  private opened: Promise<OpenedFeed> | undefined;

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
      const opening = openFeed(this.gtfsDir, { cacheDir: this.cacheDir, log: this.log });
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
    const loading = this.open().then(({ compiled, shapes }) => {
      const feed = feedForDate(compiled, date);
      let stepFree: Timetable | undefined;
      return {
        feed,
        timetable: buildTimetable(feed),
        stepFreeTimetable: () => (stepFree ??= buildTimetable(feed, { stepFree: true })),
        index: new StopIndex(feed.stops),
        tripById: new Map(feed.trips.map((t) => [t.id, t])),
        shapes,
      };
    });
    loading.catch(() => this.cache.delete(key)); // don't cache a failure
    this.cache.set(key, loading);
    while (this.cache.size > this.keep) this.cache.delete(this.cache.keys().next().value!);
    return loading;
  }

  today(): ServiceDate {
    const now = this.now();
    return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  }

  /** Stop names for an autocomplete box. */
  async stops(text: string, date?: string): Promise<string[]> {
    const { index } = await this.load(date ? parseDate(date) : this.today());
    const match = index.find(text, 10);
    return match.kind === "found" ? [match.name] : match.kind === "ambiguous" ? match.names : match.suggestions;
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
      journeys: journeys.map((j) => journeyJson(loaded, j)),
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

export function journeyJson(loaded: Loaded, journey: Journey): JourneyJson {
  return {
    departure: formatClock(journey.departure),
    arrival: formatClock(journey.arrival),
    minutes: Math.round((journey.arrival - journey.departure) / 60),
    transfers: journey.transfers,
    legs: journey.legs.map((leg) => legJson(loaded, leg)),
  };
}

function legJson({ feed, tripById, shapes }: Loaded, leg: Leg): LegJson {
  const times = { departure: formatClock(leg.departure), arrival: formatClock(leg.arrival) };
  if (leg.kind === "walk") {
    return {
      kind: "walk",
      from: stopJson(feed, leg.from),
      to: stopJson(feed, leg.to),
      ...times,
      minutes: Math.max(1, Math.round((leg.arrival - leg.departure) / 60)),
      path: [point(feed, leg.from), point(feed, leg.to)],
    };
  }
  const route = feed.routes.get(leg.routeId);
  // The stops passed: the trip's stops from where one gets on to where one gets off.
  const trip = tripById.get(leg.tripId);
  let path: LatLon[] = [point(feed, leg.from), point(feed, leg.to)];
  let shaped: LatLon[] | undefined;
  if (trip) {
    const stops = [...trip.stops];
    const start = stops.findIndex((s, i) => s === leg.from && trip.departures[i] === leg.departure);
    if (start >= 0) {
      const end = start + leg.stopCount;
      path = stops.slice(start, end + 1).map((s) => point(feed, s));
      const shape = shapes.get(trip.shapeId);
      if (shape) shaped = cut(shape, onShape(feed, trip, start), onShape(feed, trip, end));
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


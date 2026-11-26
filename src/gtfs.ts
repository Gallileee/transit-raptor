/**
 * Loading the parts of a GTFS feed that a journey planner needs, for one service date.
 *
 * A feed describes weeks of service at once: trips belong to a service (calendar.txt says on
 * which weekdays and between which dates it runs, calendar_dates.txt adds or removes single
 * days). Only trips that run on the query date are kept, plus trips of the *previous* service
 * day that are still running after midnight (their times are 24:xx or later), shifted by a day.
 *
 * Loading happens in two steps. `compileFeed` reads the CSV files once into a `CompiledFeed`:
 * every trip of every date, its stop times in typed columns (Prague: 1.7 M rows, ~30 MB).
 * `feedForDate` then cuts one day out of it in milliseconds, sharing the arrays, so a second
 * date costs no file reading, and the compiled feed is what the cache (`cache.ts`) stores.
 *
 * Spec: https://gtfs.org/documentation/schedule/reference/
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readCsv } from "./csv.js";
import { distanceMetres } from "./geo.js";
import { addDays, DAY, dateKey, isTimeZone, parseDate, parseTime, type ServiceDate, weekday } from "./time.js";

export class FeedError extends Error {}

export interface Stop {
  readonly index: number;
  readonly id: string;
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
  /** stop_id of the parent station, or "" */
  readonly parent: string;
  /** location_type: 0 stop/platform, 1 station, 2 entrance, 3 node, 4 boarding area */
  readonly locationType: number;
  readonly platform: string;
  /** level_index from levels.txt (0 = street, negative = underground), or undefined. */
  readonly level: number | undefined;
  /**
   * wheelchair_boarding after inheritance: 0 unknown, 1 step-free access, 2 none. A platform or
   * entrance with 0 takes its parent station's value, as the GTFS reference says.
   */
  readonly wheelchair: Access;
}

/** 0 no information, 1 accessible, 2 not accessible (GTFS wheelchair_boarding / _accessible). */
export type Access = 0 | 1 | 2;

function access(text: string): Access {
  return text === "1" ? 1 : text === "2" ? 2 : 0;
}

export interface Route {
  readonly id: string;
  readonly shortName: string;
  readonly longName: string;
  /** route_type: 0 tram, 1 metro, 2 rail, 3 bus, 4 ferry, 7 funicular, ... */
  readonly type: number;
  /** route_color / route_text_color as six hex digits, or "" when the feed has none. */
  readonly color: string;
  readonly textColor: string;
}

/** One trip on the query date. Times are seconds from midnight of the query date. */
export interface Trip {
  readonly id: string;
  readonly routeId: string;
  readonly headsign: string;
  readonly stops: Int32Array;
  readonly arrivals: Int32Array;
  readonly departures: Int32Array;
  /** 1 if passengers may board / get off at that stop (pickup_type / drop_off_type != 1). */
  readonly canBoard: Uint8Array;
  readonly canAlight: Uint8Array;
  /** wheelchair_accessible of the vehicle: 0 unknown, 1 yes, 2 no. */
  readonly wheelchair: Access;
  /** shape_id from trips.txt (the line it follows on the map), or "". */
  readonly shapeId: string;
  /** shape_dist_traveled of each stop from stop_times.txt, NaN where the feed has none. */
  readonly distances: Float32Array;
}

/** A walking connection from transfers.txt (transfer_type 2 with min_transfer_time). */
export interface FeedTransfer {
  readonly from: number;
  readonly to: number;
  readonly seconds: number;
}

/**
 * One edge of the graph inside a station (pathways.txt): between boarding areas, corridor
 * nodes and entrances, never directly between platforms. Escalators often go one way only.
 */
export interface Pathway {
  readonly from: number;
  readonly to: number;
  /** 1 walkway, 2 stairs, 3 moving sidewalk, 4 escalator, 5 elevator, 6 fare gate, 7 exit gate */
  readonly mode: number;
  readonly bidirectional: boolean;
  /** traversal_time in seconds, when the feed gives one. */
  readonly seconds: number | undefined;
  /** stair_count, as a positive number (the sign only says up or down). */
  readonly stairs: number;
}

export interface Feed {
  readonly date: ServiceDate;
  readonly stops: Stop[];
  readonly stopById: Map<string, number>;
  readonly routes: Map<string, Route>;
  readonly trips: Trip[];
  readonly transfers: FeedTransfer[];
  readonly pathways: Pathway[];
  readonly stats: { stopTimesRead: number; tripsInFeed: number };
}


/** calendar.txt: a service runs on these weekdays (Monday first) between two dates. */
export interface CalendarEntry {
  readonly serviceId: string;
  readonly days: readonly boolean[];
  readonly start: number; // YYYYMMDD
  readonly end: number;
}

/** calendar_dates.txt: a service added (1) or removed (2) on one date. */
export interface CalendarException {
  readonly serviceId: string;
  readonly date: number; // YYYYMMDD
  readonly type: 1 | 2;
}

export interface Calendar {
  readonly entries: readonly CalendarEntry[];
  readonly exceptions: readonly CalendarException[];
}

/**
 * A trip of the feed, whatever its dates. Its stops are rows `start .. start + length - 1` of
 * the feed's stop-time columns, already in stop_sequence order with missing times filled in.
 */
export interface CompiledTrip {
  readonly id: string;
  readonly routeId: string;
  readonly headsign: string;
  readonly serviceId: string;
  readonly wheelchair: Access;
  readonly shapeId: string;
  readonly start: number;
  readonly length: number;
  /** Why the trip can't be used (a stop without a time, an unknown stop), or "". */
  readonly error: string;
}

/** stop_times.txt of the whole feed, one row per stop of a trip, grouped by trip. */
export interface StopTimeColumns {
  readonly stops: Int32Array;
  readonly arrivals: Int32Array;
  readonly departures: Int32Array;
  readonly canBoard: Uint8Array;
  readonly canAlight: Uint8Array;
  readonly distances: Float32Array;
}

/**
 * The whole feed, for every date: what `feedForDate` cuts one day out of. Reading the CSV
 * files is the slow part (Prague: 1.7 M stop times, ~1.5 s), so this is what the cache keeps.
 */
export interface CompiledFeed {
  readonly stops: Stop[];
  readonly routes: Route[];
  readonly calendar: Calendar;
  readonly trips: CompiledTrip[];
  readonly columns: StopTimeColumns;
  readonly transfers: FeedTransfer[];
  readonly pathways: Pathway[];
  /** feed_info.txt's feed_start_date and feed_end_date (YYYYMMDD), when it gives them. */
  readonly published: PublishedDates;
  /** agency.txt's agency_timezone ("Europe/Prague"): the zone the times are in. Null if unknown. */
  readonly timeZone: string | null;
  readonly stats: { stopTimesRead: number; tripsInFeed: number };
}

/** The dates the publisher vouches for; either can be missing (both are optional in GTFS). */
export interface PublishedDates {
  readonly start: number | null;
  readonly end: number | null;
}

const REQUIRED = ["stops.txt", "routes.txt", "trips.txt", "stop_times.txt"];

/** Every file this project reads from a feed: what the cache's fingerprint is made of. */
export const FEED_FILES = [
  ...REQUIRED,
  "calendar.txt",
  "calendar_dates.txt",
  "levels.txt",
  "transfers.txt",
  "pathways.txt",
  "shapes.txt",
  "feed_info.txt",
  "agency.txt",
];

const DAY_COLUMNS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

export async function readCalendar(dir: string): Promise<Calendar> {
  const calendar = join(dir, "calendar.txt");
  const calendarDates = join(dir, "calendar_dates.txt");
  if (!existsSync(calendar) && !existsSync(calendarDates)) {
    throw new FeedError(`${dir}: neither calendar.txt nor calendar_dates.txt exists`);
  }
  const entries: CalendarEntry[] = [];
  const exceptions: CalendarException[] = [];
  if (existsSync(calendar)) {
    await readCsv(calendar, (row) => {
      entries.push({
        serviceId: row("service_id"),
        days: DAY_COLUMNS.map((day) => row(day) === "1"),
        start: Number(row("start_date")),
        end: Number(row("end_date")),
      });
    });
  }
  if (existsSync(calendarDates)) {
    await readCsv(calendarDates, (row) => {
      const type = row("exception_type");
      if (type === "1" || type === "2") {
        exceptions.push({ serviceId: row("service_id"), date: Number(row("date")), type: type === "1" ? 1 : 2 });
      }
    });
  }
  return { entries, exceptions };
}

/** Which service_ids run on `date`: the weekly calendar, then the exceptions in file order. */
export function servicesOn(calendar: Calendar, date: ServiceDate): Set<string> {
  const key = dateKey(date);
  const day = weekday(date);
  const active = new Set<string>();
  for (const entry of calendar.entries) {
    if (entry.days[day] && entry.start <= key && key <= entry.end) active.add(entry.serviceId);
  }
  for (const exception of calendar.exceptions) {
    if (exception.date !== key) continue;
    if (exception.type === 1) active.add(exception.serviceId);
    else active.delete(exception.serviceId);
  }
  return active;
}

/** The first and last date anything runs, or undefined for a feed where nothing ever runs. */
export interface ServiceRange {
  readonly first: ServiceDate;
  readonly last: ServiceDate;
}

/**
 * The dates the feed covers: from the first day some service runs to the last. The bounds come
 * from calendar.txt ranges and added dates; a range can start on a day its weekdays skip (PID's
 * weekday services from a Sunday), so each end is moved in to the nearest day that has service.
 */
export function serviceRange(calendar: Calendar): ServiceRange | undefined {
  let low = Infinity;
  let high = -Infinity;
  for (const entry of calendar.entries) {
    if (!entry.days.includes(true) || entry.end < entry.start) continue;
    low = Math.min(low, entry.start);
    high = Math.max(high, entry.end);
  }
  for (const exception of calendar.exceptions) {
    if (exception.type !== 1) continue;
    low = Math.min(low, exception.date);
    high = Math.max(high, exception.date);
  }
  if (low > high) return undefined;
  let first = fromDateKey(low);
  let last = fromDateKey(high);
  while (dateKey(first) <= high && servicesOn(calendar, first).size === 0) first = addDays(first, 1);
  if (dateKey(first) > high) return undefined; // every date removed again
  while (servicesOn(calendar, last).size === 0) last = addDays(last, -1);
  return { first, last };
}

/**
 * agency.txt's agency_timezone: GTFS requires every agency of a feed to give the same one, so the
 * first known zone is it. Null when the file is missing or no row names a zone this runtime knows.
 */
export async function readTimeZone(dir: string): Promise<string | null> {
  const path = join(dir, "agency.txt");
  if (!existsSync(path)) return null;
  let zone: string | null = null;
  await readCsv(path, (row) => {
    const name = row("agency_timezone").trim();
    if (zone === null && isTimeZone(name)) zone = name;
  });
  return zone;
}

/** feed_info.txt (optional, one row): the period the feed is complete and reliable for. */
export async function readPublishedDates(dir: string): Promise<PublishedDates> {
  const path = join(dir, "feed_info.txt");
  let dates: PublishedDates = { start: null, end: null };
  if (!existsSync(path)) return dates;
  const key = (text: string) => {
    if (!/^\s*\d{8}\s*$/.test(text)) return null;
    try {
      return dateKey(parseDate(text)); // no 13th month or 31 April
    } catch {
      return null;
    }
  };
  let first = true;
  await readCsv(path, (row) => {
    if (first) dates = { start: key(row("feed_start_date")), end: key(row("feed_end_date")) };
    first = false;
  });
  return dates;
}

/**
 * The dates the feed covers, for telling people: feed_info.txt's dates where it gives them,
 * the calendar's otherwise. The calendar alone can say too much: PID's train services run all
 * year in calendar.txt while the rest of the feed (and feed_end_date) stops two weeks ahead.
 */
export function coveredDates(compiled: Pick<CompiledFeed, "calendar" | "published">): ServiceRange | undefined {
  const calendar = serviceRange(compiled.calendar);
  const { start, end } = compiled.published;
  const first = start !== null ? fromDateKey(start) : calendar?.first;
  const last = end !== null ? fromDateKey(end) : calendar?.last;
  if (!first || !last || dateKey(first) > dateKey(last)) return undefined;
  return { first, last };
}

function fromDateKey(key: number): ServiceDate {
  return { year: Math.floor(key / 10000), month: Math.floor(key / 100) % 100, day: key % 100 };
}

/** Platforms whose boarding areas are all named after one track ("Kolej 2 - Start" -> "2"). */
function tracksFromAreas(stops: readonly Stop[], stopById: ReadonlyMap<string, number>): Map<number, string> {
  const named = new Map<number, Set<string>>();
  for (const stop of stops) {
    if (stop.locationType !== 4) continue;
    const platform = stopById.get(stop.parent);
    if (platform === undefined) continue;
    const track = /^Kolej (\d+)\b/.exec(stop.name)?.[1] ?? "?";
    named.set(platform, (named.get(platform) ?? new Set()).add(track));
  }
  const tracks = new Map<number, string>();
  for (const [platform, names] of named) {
    const [track] = names;
    if (names.size === 1 && track !== "?") tracks.set(platform, track!);
  }
  return tracks;
}

/** Which service_ids run on `date`, from calendar.txt and calendar_dates.txt. */
export async function activeServices(dir: string, date: ServiceDate): Promise<Set<string>> {
  return servicesOn(await readCalendar(dir), date);
}

/** Load everything needed to plan journeys on `date` (reads the CSV files every time). */
export async function loadFeed(dir: string, date: ServiceDate): Promise<Feed> {
  return feedForDate(await compileFeed(dir), date);
}

/** Read a feed directory into a `CompiledFeed`: all trips of all dates. */
export async function compileFeed(dir: string): Promise<CompiledFeed> {
  for (const file of REQUIRED) {
    if (!existsSync(join(dir, file))) throw new FeedError(`${dir}: missing ${file} (is this an unzipped GTFS feed?)`);
  }

  // Levels (optional): how deep each part of a station is, e.g. a metro platform at -4.
  const levels = new Map<string, number>();
  const levelsFile = join(dir, "levels.txt");
  if (existsSync(levelsFile)) {
    await readCsv(levelsFile, (row) => {
      const index = Number(row("level_index"));
      if (row("level_id") && Number.isFinite(index)) levels.set(row("level_id"), index);
    });
  }

  const stops: (Stop & { wheelchair: Access })[] = [];
  const stopById = new Map<string, number>();
  await readCsv(join(dir, "stops.txt"), (row) => {
    const index = stops.length;
    const stop: Stop = {
      index,
      id: row("stop_id"),
      name: row("stop_name"),
      lat: Number(row("stop_lat")),
      lon: Number(row("stop_lon")),
      parent: row("parent_station"),
      locationType: Number(row("location_type") || "0"),
      platform: row("platform_code"),
      level: levels.get(row("level_id")),
      wheelchair: access(row("wheelchair_boarding")),
    };
    stops.push(stop);
    stopById.set(stop.id, index);
  });

  // A platform without a platform_code takes the track number its boarding areas are named
  // after ("Kolej 1"), when they all agree: PID leaves the code out at 14 metro platforms
  // (Muzeum, Můstek, Florenc, Nádraží Veleslavín) and names their areas. Where the feed has both,
  // they agree at 106 of 108 platforms (Vysočanská has them crossed; the code is kept there).
  for (const [platform, track] of tracksFromAreas(stops, stopById)) {
    if (!stops[platform]!.platform) stops[platform] = { ...stops[platform]!, platform: track };
  }

  // Unknown on a platform or entrance means "as the station" (a parent may come later in the file).
  for (const stop of stops) {
    if (stop.wheelchair !== 0 || !stop.parent) continue;
    const parent = stopById.get(stop.parent);
    if (parent !== undefined && stops[parent]!.locationType === 1) stop.wheelchair = stops[parent]!.wheelchair;
  }

  const routes: Route[] = [];
  await readCsv(join(dir, "routes.txt"), (row) => {
    routes.push({
      id: row("route_id"),
      shortName: row("route_short_name"),
      longName: row("route_long_name"),
      type: Number(row("route_type")),
      color: hexColor(row("route_color")),
      textColor: hexColor(row("route_text_color")),
    });
  });

  const calendar = await readCalendar(dir);

  const tripMeta: Omit<CompiledTrip, "start" | "length" | "error">[] = [];
  const tripIndex = new Map<string, number>();
  const tripsInFeed = await readCsv(join(dir, "trips.txt"), (row) => {
    const id = row("trip_id");
    // A repeated trip_id replaces the earlier row but keeps its place, as a Map would.
    const at = tripIndex.get(id) ?? tripMeta.length;
    tripIndex.set(id, at);
    tripMeta[at] = {
      id,
      routeId: row("route_id"),
      headsign: row("trip_headsign"),
      serviceId: row("service_id"),
      wheelchair: access(row("wheelchair_accessible")),
      shapeId: row("shape_id"),
    };
  });

  const builder = new StopTimeBuilder(tripMeta.length);
  const errors: string[] = Array.from({ length: tripMeta.length }, () => "");
  const stopTimesRead = await readCsv(join(dir, "stop_times.txt"), (row) => {
    const trip = tripIndex.get(row("trip_id"));
    if (trip === undefined) return;
    const stop = stopById.get(row("stop_id"));
    if (stop === undefined) {
      // Only an error if the trip runs on the date asked for, as when trips were filtered first.
      errors[trip] ||= `stop_times.txt: unknown stop_id "${row("stop_id")}"`;
      return;
    }
    const arrival = row("arrival_time");
    const departure = row("departure_time");
    // Empty times (stops that aren't timepoints) are filled in later; -1 marks them.
    const arr = arrival ? parseTime(arrival) : departure ? parseTime(departure) : -1;
    const dep = departure ? parseTime(departure) : arr;
    builder.add(
      trip,
      Number(row("stop_sequence")),
      stop,
      arr,
      dep,
      row("pickup_type") === "1" ? 0 : 1,
      row("drop_off_type") === "1" ? 0 : 1,
      row("shape_dist_traveled") === "" ? NaN : Number(row("shape_dist_traveled")),
    );
  });
  const { columns, start } = builder.build();

  const trips = tripMeta.map((meta, t): CompiledTrip => {
    const [s, e] = [start[t]!, start[t + 1]!];
    let error = errors[t]!;
    if (!error && e - s >= 2) {
      if (columns.arrivals[s]! < 0) error = `trip ${meta.id}: the first stop has no time`;
      else interpolateTimes(columns, s, e, stops);
    }
    return { ...meta, start: s, length: e - s, error };
  });

  const transfers: FeedTransfer[] = [];
  const transfersFile = join(dir, "transfers.txt");
  if (existsSync(transfersFile)) {
    await readCsv(transfersFile, (row) => {
      const from = stopById.get(row("from_stop_id"));
      const to = stopById.get(row("to_stop_id"));
      const seconds = Number(row("min_transfer_time"));
      if (from !== undefined && to !== undefined && row("transfer_type") === "2" && Number.isFinite(seconds)) {
        transfers.push({ from, to, seconds });
      }
    });
  }

  const pathways: Pathway[] = [];
  const pathwaysFile = join(dir, "pathways.txt");
  if (existsSync(pathwaysFile)) {
    await readCsv(pathwaysFile, (row) => {
      const from = stopById.get(row("from_stop_id"));
      const to = stopById.get(row("to_stop_id"));
      if (from === undefined || to === undefined) return;
      const seconds = row("traversal_time") === "" ? undefined : Number(row("traversal_time"));
      pathways.push({
        from,
        to,
        mode: Number(row("pathway_mode")),
        bidirectional: row("is_bidirectional") === "1",
        seconds: seconds !== undefined && Number.isFinite(seconds) ? seconds : undefined,
        stairs: Math.abs(Number(row("stair_count")) || 0),
      });
    });
  }

  const published = await readPublishedDates(dir);
  const timeZone = await readTimeZone(dir);
  return {
    stops,
    routes,
    calendar,
    trips,
    columns,
    transfers,
    pathways,
    published,
    timeZone,
    stats: { stopTimesRead, tripsInFeed },
  };
}

/**
 * Cut one service date out of a compiled feed: the trips running that day, plus the trips of
 * the previous day still running after midnight, shifted by a day. Trips of that day share
 * the feed's stop-time arrays (no copy); only the shifted ones get arrays of their own.
 */
export function feedForDate(compiled: CompiledFeed, date: ServiceDate): Feed {
  const today = servicesOn(compiled.calendar, date);
  const yesterday = servicesOn(compiled.calendar, addDays(date, -1));
  const { columns } = compiled;
  const trips: Trip[] = [];
  for (const meta of compiled.trips) {
    const offsets: number[] = [];
    if (yesterday.has(meta.serviceId)) offsets.push(-DAY);
    if (today.has(meta.serviceId)) offsets.push(0);
    if (offsets.length === 0) continue;
    if (meta.error) throw new FeedError(meta.error);
    if (meta.length < 2) continue;
    const [s, e] = [meta.start, meta.start + meta.length];
    const trip: Trip = {
      id: meta.id,
      routeId: meta.routeId,
      headsign: meta.headsign,
      stops: columns.stops.subarray(s, e),
      arrivals: columns.arrivals.subarray(s, e),
      departures: columns.departures.subarray(s, e),
      canBoard: columns.canBoard.subarray(s, e),
      canAlight: columns.canAlight.subarray(s, e),
      wheelchair: meta.wheelchair,
      shapeId: meta.shapeId,
      distances: columns.distances.subarray(s, e),
    };
    for (const offset of offsets) {
      // A trip of the previous day only matters if it is still running after midnight.
      if (offset < 0 && trip.arrivals[trip.arrivals.length - 1]! + offset < 0) continue;
      trips.push(offset === 0 ? trip : shift(trip, offset));
    }
  }
  return {
    date,
    stops: compiled.stops,
    stopById: stopIndexOf(compiled),
    routes: routeMapOf(compiled),
    trips,
    transfers: compiled.transfers,
    pathways: compiled.pathways,
    stats: compiled.stats,
  };
}

// Built once per compiled feed and shared by all its dates.
const stopIndexes = new WeakMap<CompiledFeed, Map<string, number>>();
const routeMaps = new WeakMap<CompiledFeed, Map<string, Route>>();

function stopIndexOf(compiled: CompiledFeed): Map<string, number> {
  let map = stopIndexes.get(compiled);
  if (!map) stopIndexes.set(compiled, (map = new Map(compiled.stops.map((s) => [s.id, s.index]))));
  return map;
}

function routeMapOf(compiled: CompiledFeed): Map<string, Route> {
  let map = routeMaps.get(compiled);
  if (!map) routeMaps.set(compiled, (map = new Map(compiled.routes.map((r) => [r.id, r]))));
  return map;
}

/** "00a562" or "#00A562" -> "00A562"; anything else -> "". */
function hexColor(text: string): string {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(text.trim());
  return match ? match[1]!.toUpperCase() : "";
}

/**
 * Collects stop times in file order into growing typed arrays, then groups them by trip
 * (counting sort, file order kept) and sorts by stop_sequence only where a trip's rows aren't
 * in order already. The same approach as for shapes: a JS array per trip costs far more.
 */
/**
 * Stops without times (-1) in the stop times `s` to `e` of one trip get times between the timed
 * stops around them, as GTFS asks, in proportion to the distance between: shape_dist_traveled
 * where every stop of the stretch has it and it doesn't go back, else straight lines from stop
 * to stop (equal steps if the stops are all in one place). Stops after the last timed one take
 * its departure: there is nothing to go on (GTFS wants the last stop timed). The first stop
 * must have a time. Times are whole seconds; arrival and departure are the same.
 */
export function interpolateTimes(
  columns: { arrivals: Int32Array; departures: Int32Array; stops: Int32Array; distances: Float32Array },
  s: number,
  e: number,
  stops: readonly { lat: number; lon: number }[],
): void {
  const { arrivals, departures, stops: at, distances } = columns;
  for (let i = s + 1; i < e; i++) {
    if (arrivals[i]! >= 0) continue;
    const before = i - 1; // timed, or filled in just now
    let after = i;
    while (after < e && arrivals[after]! < 0) after++;
    const from = departures[before]!;
    if (after === e || arrivals[after]! < from) {
      // Nothing timed after it (or a time going back): the last time known, never earlier.
      for (let k = i; k < after; k++) arrivals[k] = departures[k] = from;
      i = after;
      continue;
    }
    const to = arrivals[after]!;
    // How far along the stretch each stop is.
    const along = new Float64Array(after - before + 1);
    let shaped = true;
    for (let k = before; k <= after; k++) {
      const d = distances[k]!;
      if (!Number.isFinite(d) || (k > before && d < distances[k - 1]!)) shaped = false;
    }
    for (let k = before + 1; k <= after; k++) {
      const a = stops[at[k - 1]!]!;
      const b = stops[at[k]!]!;
      along[k - before] = shaped ? distances[k]! - distances[before]! : along[k - before - 1]! + distanceMetres(a.lat, a.lon, b.lat, b.lon);
    }
    const total = along[after - before]!;
    for (let k = i; k < after; k++) {
      const share = total > 0 ? along[k - before]! / total : (k - before) / (after - before);
      arrivals[k] = departures[k] = Math.round(from + (to - from) * share);
    }
    i = after;
  }
}

class StopTimeBuilder {
  private readonly counts: Int32Array;
  private n = 0;
  private trip = new Int32Array(1024);
  private sequence = new Float64Array(1024);
  private stop = new Int32Array(1024);
  private arrival = new Int32Array(1024);
  private departure = new Int32Array(1024);
  private board = new Uint8Array(1024);
  private alight = new Uint8Array(1024);
  private distance = new Float32Array(1024);

  constructor(trips: number) {
    this.counts = new Int32Array(trips);
  }

  add(trip: number, sequence: number, stop: number, arr: number, dep: number, board: number, alight: number, dist: number) {
    if (this.n === this.trip.length) this.grow();
    const i = this.n++;
    this.counts[trip]!++;
    this.trip[i] = trip;
    this.sequence[i] = sequence;
    this.stop[i] = stop;
    this.arrival[i] = arr;
    this.departure[i] = dep;
    this.board[i] = board;
    this.alight[i] = alight;
    this.distance[i] = dist;
  }

  private grow(): void {
    const size = this.trip.length * 2;
    const bigger = <T extends Int32Array | Uint8Array | Float32Array | Float64Array>(old: T, make: (n: number) => T): T => {
      const array = make(size);
      array.set(old);
      return array;
    };
    this.trip = bigger(this.trip, (n) => new Int32Array(n));
    this.sequence = bigger(this.sequence, (n) => new Float64Array(n));
    this.stop = bigger(this.stop, (n) => new Int32Array(n));
    this.arrival = bigger(this.arrival, (n) => new Int32Array(n));
    this.departure = bigger(this.departure, (n) => new Int32Array(n));
    this.board = bigger(this.board, (n) => new Uint8Array(n));
    this.alight = bigger(this.alight, (n) => new Uint8Array(n));
    this.distance = bigger(this.distance, (n) => new Float32Array(n));
  }

  build(): { columns: StopTimeColumns; start: Int32Array } {
    const { n, counts } = this;
    const trips = counts.length;
    const start = new Int32Array(trips + 1);
    for (let t = 0; t < trips; t++) start[t + 1] = start[t]! + counts[t]!;
    const next = start.slice(0, trips);
    const order = new Int32Array(n);
    for (let i = 0; i < n; i++) order[next[this.trip[i]!]!++] = i;
    for (let t = 0; t < trips; t++) {
      const part = order.subarray(start[t]!, start[t + 1]!);
      if (part.some((row, j) => j > 0 && this.sequence[row]! < this.sequence[part[j - 1]!]!)) {
        part.set(Array.from(part).sort((a, b) => this.sequence[a]! - this.sequence[b]!));
      }
    }
    const columns: StopTimeColumns = {
      stops: new Int32Array(n),
      arrivals: new Int32Array(n),
      departures: new Int32Array(n),
      canBoard: new Uint8Array(n),
      canAlight: new Uint8Array(n),
      distances: new Float32Array(n),
    };
    for (let to = 0; to < n; to++) {
      const from = order[to]!;
      columns.stops[to] = this.stop[from]!;
      columns.arrivals[to] = this.arrival[from]!;
      columns.departures[to] = this.departure[from]!;
      columns.canBoard[to] = this.board[from]!;
      columns.canAlight[to] = this.alight[from]!;
      columns.distances[to] = this.distance[from]!;
    }
    return { columns, start };
  }
}

function shift(trip: Trip, offset: number): Trip {
  return {
    ...trip,
    id: `${trip.id}@prev`,
    arrivals: trip.arrivals.map((t) => t + offset),
    departures: trip.departures.map((t) => t + offset),
  };
}

/**
 * Loading the parts of a GTFS feed that a journey planner needs, for one service date.
 *
 * A feed describes weeks of service at once: trips belong to a service (calendar.txt says on
 * which weekdays and between which dates it runs, calendar_dates.txt adds or removes single
 * days). Only trips that run on the query date are kept, plus trips of the *previous* service
 * day that are still running after midnight (their times are 24:xx or later), shifted by a day.
 * That keeps memory proportional to one day of service, not to the whole feed.
 *
 * Spec: https://gtfs.org/documentation/schedule/reference/
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readCsv } from "./csv.js";
import { addDays, DAY, dateKey, parseTime, type ServiceDate, weekday } from "./time.js";

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

const REQUIRED = ["stops.txt", "routes.txt", "trips.txt", "stop_times.txt"];

/** Which service_ids run on `date`, from calendar.txt and calendar_dates.txt. */
export async function activeServices(dir: string, date: ServiceDate): Promise<Set<string>> {
  const key = dateKey(date);
  const day = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"][weekday(date)]!;
  const active = new Set<string>();
  const calendar = join(dir, "calendar.txt");
  const calendarDates = join(dir, "calendar_dates.txt");
  if (!existsSync(calendar) && !existsSync(calendarDates)) {
    throw new FeedError(`${dir}: neither calendar.txt nor calendar_dates.txt exists`);
  }
  if (existsSync(calendar)) {
    await readCsv(calendar, (row) => {
      if (row(day) === "1" && Number(row("start_date")) <= key && key <= Number(row("end_date"))) {
        active.add(row("service_id"));
      }
    });
  }
  if (existsSync(calendarDates)) {
    await readCsv(calendarDates, (row) => {
      if (Number(row("date")) !== key) return;
      if (row("exception_type") === "1") active.add(row("service_id"));
      else if (row("exception_type") === "2") active.delete(row("service_id"));
    });
  }
  return active;
}

interface PendingTrip {
  id: string;
  routeId: string;
  headsign: string;
  /** Shifts in seconds: 0 for the query date, -DAY for the previous service day. */
  offsets: number[];
  rows: number[]; // flattened: sequence, stop index, arrival, departure, board, alight
}

/** Load everything needed to plan journeys on `date`. */
export async function loadFeed(dir: string, date: ServiceDate): Promise<Feed> {
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

  const stops: Stop[] = [];
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
    };
    stops.push(stop);
    stopById.set(stop.id, index);
  });

  const routes = new Map<string, Route>();
  await readCsv(join(dir, "routes.txt"), (row) => {
    routes.set(row("route_id"), {
      id: row("route_id"),
      shortName: row("route_short_name"),
      longName: row("route_long_name"),
      type: Number(row("route_type")),
      color: hexColor(row("route_color")),
      textColor: hexColor(row("route_text_color")),
    });
  });

  const today = await activeServices(dir, date);
  const yesterday = await activeServices(dir, addDays(date, -1));

  const pending = new Map<string, PendingTrip>();
  let tripsInFeed = 0;
  await readCsv(join(dir, "trips.txt"), (row) => {
    tripsInFeed++;
    const service = row("service_id");
    const offsets: number[] = [];
    if (yesterday.has(service)) offsets.push(-DAY);
    if (today.has(service)) offsets.push(0);
    if (offsets.length === 0) return;
    const id = row("trip_id");
    pending.set(id, { id, routeId: row("route_id"), headsign: row("trip_headsign"), offsets, rows: [] });
  });

  let stopTimesRead = 0;
  await readCsv(join(dir, "stop_times.txt"), (row) => {
    stopTimesRead++;
    const trip = pending.get(row("trip_id"));
    if (trip === undefined) return;
    const stop = stopById.get(row("stop_id"));
    if (stop === undefined) throw new FeedError(`stop_times.txt: unknown stop_id "${row("stop_id")}"`);
    const arrival = row("arrival_time");
    const departure = row("departure_time");
    // Empty times (stops that aren't timepoints) are filled in later; -1 marks them.
    const arr = arrival ? parseTime(arrival) : departure ? parseTime(departure) : -1;
    const dep = departure ? parseTime(departure) : arr;
    trip.rows.push(
      Number(row("stop_sequence")),
      stop,
      arr,
      dep,
      row("pickup_type") === "1" ? 0 : 1,
      row("drop_off_type") === "1" ? 0 : 1,
    );
  });

  const trips: Trip[] = [];
  for (const trip of pending.values()) {
    const built = buildTrip(trip);
    if (built === undefined) continue;
    for (const offset of trip.offsets) {
      // A trip of the previous day only matters if it is still running after midnight.
      if (offset < 0 && built.arrivals[built.arrivals.length - 1]! + offset < 0) continue;
      trips.push(offset === 0 ? built : shift(built, offset));
    }
  }

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

  return { date, stops, stopById, routes, trips, transfers, pathways, stats: { stopTimesRead, tripsInFeed } };
}

/** "00a562" or "#00A562" -> "00A562"; anything else -> "". */
function hexColor(text: string): string {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(text.trim());
  return match ? match[1]!.toUpperCase() : "";
}

const FIELDS = 6;

function buildTrip(pending: PendingTrip): Trip | undefined {
  const n = pending.rows.length / FIELDS;
  if (n < 2) return undefined;
  const order = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => pending.rows[a * FIELDS]! - pending.rows[b * FIELDS]!,
  );
  const stops = new Int32Array(n);
  const arrivals = new Int32Array(n);
  const departures = new Int32Array(n);
  const canBoard = new Uint8Array(n);
  const canAlight = new Uint8Array(n);
  order.forEach((from, to) => {
    const base = from * FIELDS;
    stops[to] = pending.rows[base + 1]!;
    arrivals[to] = pending.rows[base + 2]!;
    departures[to] = pending.rows[base + 3]!;
    canBoard[to] = pending.rows[base + 4]!;
    canAlight[to] = pending.rows[base + 5]!;
  });
  // Stops without times take the time of the last stop that had one (never too early, which
  // would let a connection look possible when it isn't). The first stop must have a time.
  if (arrivals[0]! < 0) throw new FeedError(`trip ${pending.id}: the first stop has no time`);
  for (let i = 1; i < n; i++) {
    if (arrivals[i]! < 0) arrivals[i] = departures[i - 1]!;
    if (departures[i]! < 0) departures[i] = arrivals[i]!;
  }
  return { id: pending.id, routeId: pending.routeId, headsign: pending.headsign, stops, arrivals, departures, canBoard, canAlight };
}

function shift(trip: Trip, offset: number): Trip {
  return {
    ...trip,
    id: `${trip.id}@prev`,
    arrivals: trip.arrivals.map((t) => t + offset),
    departures: trip.departures.map((t) => t + offset),
  };
}

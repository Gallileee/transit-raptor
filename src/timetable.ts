/**
 * The data layout RAPTOR scans: trips grouped into *patterns*, and walking connections.
 *
 * A pattern is a set of trips that stop at exactly the same stops in the same order (with the
 * same boarding rules). Within a pattern the trips are sorted by departure, and no trip may
 * overtake another; RAPTOR relies on that to find "the earliest trip I can still catch here"
 * with a binary search. Trips that do overtake (an express on the same stops) go to a pattern
 * of their own.
 *
 * Times of a pattern are one flat Int32Array: for trip t and stop position i,
 * times[(t * n + i) * 2] is the arrival and times[(t * n + i) * 2 + 1] the departure.
 */
import type { Feed, Trip } from "./gtfs.js";

export interface Pattern {
  readonly index: number;
  readonly routeId: string;
  readonly stops: Int32Array;
  readonly canBoard: Uint8Array;
  readonly canAlight: Uint8Array;
  readonly trips: Trip[];
  readonly times: Int32Array;
}

export interface Footpath {
  readonly to: number;
  readonly seconds: number;
}

export interface WalkOptions {
  /** Longest walk between two stops, in metres (straight line). */
  readonly maxMetres: number;
  /** Walking speed in metres per second. */
  readonly speed: number;
  /** Straight-line distance times this factor approximates the real path. */
  readonly detour: number;
  /** Shortest walk between two different stops, in seconds (stairs, crossing, finding the platform). */
  readonly minSeconds: number;
  /**
   * Extra seconds per level of height difference (levels.txt), for escalators and stairs: two
   * metro platforms 90 m apart but two levels apart, like line A and B at Mustek, are a
   * three-minute change, not one.
   */
  readonly secondsPerLevel: number;
}

/**
 * Deliberately cautious. Compared with the official PID planner (IDOS) on 10 Nov 2026, no choice
 * of these numbers matches every station: IDOS needs at least 3 min for Mustek B->A (86 m,
 * 2 levels) but under 3 min for Nadrazi Veleslavin metro->trolleybus (140 m, 3 levels), the
 * opposite of what distance and depth predict. IDOS uses times specific to each station.
 * Erring long only hides a connection; erring short suggests a change that fails in reality,
 * so these values err long (Mustek: 183 s, as IDOS; Veleslavin: 290 s, IDOS about 2 min).
 * pathways.txt (corridors, escalators, stairs inside stations) is the real fix; see PROGRESS.md.
 */
export const DEFAULT_WALK: WalkOptions = {
  maxMetres: 300,
  speed: 1.2,
  detour: 1.3,
  minSeconds: 60,
  secondsPerLevel: 45,
};

export interface Timetable {
  readonly feed: Feed;
  readonly patterns: Pattern[];
  /** For each stop: the patterns stopping there and the position(s) in them. */
  readonly stopPatterns: { pattern: number; position: number }[][];
  /** For each stop: where one can walk to, and how long it takes. */
  readonly footpaths: Footpath[][];
}

export function arrival(p: Pattern, trip: number, position: number): number {
  return p.times[(trip * p.stops.length + position) * 2]!;
}

export function departure(p: Pattern, trip: number, position: number): number {
  return p.times[(trip * p.stops.length + position) * 2 + 1]!;
}

export function buildTimetable(feed: Feed, walk: WalkOptions = DEFAULT_WALK): Timetable {
  const groups = new Map<string, Trip[]>();
  for (const trip of feed.trips) {
    const key = `${trip.routeId}|${trip.stops.join(",")}|${trip.canBoard.join("")}|${trip.canAlight.join("")}`;
    const group = groups.get(key);
    if (group) group.push(trip);
    else groups.set(key, [trip]);
  }

  const patterns: Pattern[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.departures[0]! - b.departures[0]! || a.arrivals.at(-1)! - b.arrivals.at(-1)!);
    for (const lane of splitOvertaking(group)) patterns.push(makePattern(patterns.length, lane));
  }

  const stopPatterns: { pattern: number; position: number }[][] = feed.stops.map(() => []);
  for (const p of patterns) {
    p.stops.forEach((stop, position) => stopPatterns[stop]!.push({ pattern: p.index, position }));
  }

  return { feed, patterns, stopPatterns, footpaths: buildFootpaths(feed, walk) };
}

/** Split trips (sorted by first departure) into lanes in which no trip overtakes another. */
function splitOvertaking(trips: Trip[]): Trip[][] {
  const lanes: Trip[][] = [];
  for (const trip of trips) {
    const lane = lanes.find((l) => !overtakes(l[l.length - 1]!, trip));
    if (lane) lane.push(trip);
    else lanes.push([trip]);
  }
  return lanes;
}

/** True if `later` (departing no earlier) is ahead of `earlier` at some stop. */
function overtakes(earlier: Trip, later: Trip): boolean {
  for (let i = 0; i < earlier.stops.length; i++) {
    if (later.arrivals[i]! < earlier.arrivals[i]! || later.departures[i]! < earlier.departures[i]!) return true;
  }
  return false;
}

function makePattern(index: number, trips: Trip[]): Pattern {
  const first = trips[0]!;
  const n = first.stops.length;
  const times = new Int32Array(trips.length * n * 2);
  trips.forEach((trip, t) => {
    for (let i = 0; i < n; i++) {
      times[(t * n + i) * 2] = trip.arrivals[i]!;
      times[(t * n + i) * 2 + 1] = trip.departures[i]!;
    }
  });
  return { index, routeId: first.routeId, stops: first.stops, canBoard: first.canBoard, canAlight: first.canAlight, trips, times };
}

const METRES_PER_DEGREE = 111_320;

/** Straight-line distance in metres (equirectangular: plenty accurate for a few hundred metres). */
export function distanceMetres(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const x = (lon2 - lon1) * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  const y = lat2 - lat1;
  return Math.sqrt(x * x + y * y) * METRES_PER_DEGREE;
}

/**
 * Walking connections between stops: every pair closer than walk.maxMetres (found with a grid,
 * so it isn't a comparison of every stop with every other one), plus transfers.txt entries,
 * which win when they say a walk takes longer or shorter. A stop without a level counts as
 * street level (0).
 */
function buildFootpaths(feed: Feed, walk: WalkOptions): Footpath[][] {
  const best = feed.stops.map(() => new Map<number, number>());
  const usable = feed.stops.filter((s) => s.locationType === 0 && Number.isFinite(s.lat) && Number.isFinite(s.lon));

  const cellDegrees = walk.maxMetres / METRES_PER_DEGREE;
  const cells = new Map<string, number[]>();
  const cellOf = (lat: number, lon: number): [number, number] => [
    Math.floor(lat / cellDegrees),
    Math.floor(lon / cellDegrees),
  ];
  for (const stop of usable) {
    const [cy, cx] = cellOf(stop.lat, stop.lon);
    const key = `${cy}:${cx}`;
    const cell = cells.get(key);
    if (cell) cell.push(stop.index);
    else cells.set(key, [stop.index]);
  }
  for (const stop of usable) {
    const [cy, cx] = cellOf(stop.lat, stop.lon);
    // A longitude degree is shorter than a latitude degree away from the equator, so the
    // search looks further in that direction.
    const reachX = Math.ceil(1 / Math.cos(stop.lat * (Math.PI / 180)));
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -reachX; dx <= reachX; dx++) {
        for (const other of cells.get(`${cy + dy}:${cx + dx}`) ?? []) {
          if (other === stop.index) continue;
          const o = feed.stops[other]!;
          const metres = distanceMetres(stop.lat, stop.lon, o.lat, o.lon);
          if (metres > walk.maxMetres) continue;
          const levels = Math.abs((stop.level ?? 0) - (o.level ?? 0));
          const seconds =
            Math.max(walk.minSeconds, Math.ceil((metres * walk.detour) / walk.speed)) + levels * walk.secondsPerLevel;
          best[stop.index]!.set(other, seconds);
        }
      }
    }
  }
  for (const t of feed.transfers) {
    if (t.from !== t.to) best[t.from]!.set(t.to, t.seconds);
  }
  return best.map((m) => [...m].map(([to, seconds]) => ({ to, seconds })).sort((a, b) => a.seconds - b.seconds));
}

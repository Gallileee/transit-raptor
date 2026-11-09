/**
 * RAPTOR: Round-bAsed Public Transit Optimized Router.
 *
 * Delling, Pajor, Werneck: "Round-Based Public Transit Routing", Transportation Science 49(3),
 * 2015 (ALENEX 2012). https://www.microsoft.com/en-us/research/?p=162045
 *
 * Instead of a Dijkstra-style priority queue over a graph, RAPTOR works in rounds. Round k
 * finds the earliest arrival at every stop using at most k vehicles:
 *
 *   1. Collect the patterns that stop at a stop improved in the previous round.
 *   2. Scan each of those patterns once, from the first improved stop onwards: hop on the
 *      earliest trip that can still be caught, and record its arrival at every later stop
 *      where that is an improvement.
 *   3. Walk: from every stop improved by a vehicle in this round, follow the footpaths.
 *
 * Because round k only uses arrivals of round k - 1, the result is one journey per number of
 * vehicles: "arrive 08:41 with 1 transfer, or 08:36 with 2". Keeping only those that arrive
 * earlier than every journey with fewer transfers gives the Pareto set over (arrival, transfers).
 */
import type { Timetable } from "./timetable.js";
import { arrival, departure } from "./timetable.js";

export interface RideLeg {
  readonly kind: "ride";
  readonly routeId: string;
  readonly tripId: string;
  readonly headsign: string;
  readonly from: number;
  readonly to: number;
  readonly departure: number;
  readonly arrival: number;
  /** Stops passed on the way, not counting the first one. */
  readonly stopCount: number;
}

export interface WalkLeg {
  readonly kind: "walk";
  readonly from: number;
  readonly to: number;
  readonly departure: number;
  readonly arrival: number;
}

export type Leg = RideLeg | WalkLeg;

export interface Journey {
  readonly legs: Leg[];
  readonly departure: number;
  readonly arrival: number;
  readonly transfers: number;
}

export interface Query {
  /** Stops one may start at (e.g. every platform of "Anděl"). */
  readonly from: number[];
  /** Stops one may end at. */
  readonly to: number[];
  /** Seconds after midnight of the timetable's date. */
  readonly departAt: number;
  /** At most this many changes between vehicles. */
  readonly maxTransfers: number;
}

const NONE = 0;
const ORIGIN = 1;
const RIDE = 2;
const WALK = 3;

/** How a stop was reached in one round, for walking the journey back afterwards. */
interface Labels {
  arrival: Float64Array;
  kind: Uint8Array;
  pattern: Int32Array;
  trip: Int32Array;
  boardPosition: Int32Array;
  alightPosition: Int32Array;
  walkFrom: Int32Array;
}

function labels(n: number, previous?: Labels): Labels {
  return {
    // Arrival times carry over: with k vehicles one is never later than with k - 1.
    arrival: previous ? previous.arrival.slice() : new Float64Array(n).fill(Infinity),
    kind: new Uint8Array(n),
    pattern: new Int32Array(n).fill(-1),
    trip: new Int32Array(n).fill(-1),
    boardPosition: new Int32Array(n).fill(-1),
    alightPosition: new Int32Array(n).fill(-1),
    walkFrom: new Int32Array(n).fill(-1),
  };
}

/** The earliest trip of pattern `p` that leaves `position` at or after `time`, or -1. */
function earliestTrip(tt: Timetable, p: number, position: number, time: number): number {
  const pattern = tt.patterns[p]!;
  let lo = 0;
  let hi = pattern.trips.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (departure(pattern, mid, position) < time) lo = mid + 1;
    else hi = mid;
  }
  return lo < pattern.trips.length ? lo : -1;
}

export function plan(tt: Timetable, query: Query): Journey[] {
  const n = tt.feed.stops.length;
  const targets = new Set(query.to);
  if (query.from.length === 0 || targets.size === 0) return [];
  if (query.from.some((s) => targets.has(s))) return [];

  const rounds: Labels[] = [labels(n)];
  const best = new Float64Array(n).fill(Infinity);
  let marked = new Set<number>();

  // Round 0: being at the origin, and walking from there.
  const start = rounds[0]!;
  for (const s of query.from) {
    start.arrival[s] = query.departAt;
    start.kind[s] = ORIGIN;
    best[s] = query.departAt;
    marked.add(s);
  }
  for (const s of query.from) {
    for (const { to, seconds } of tt.footpaths[s]!) {
      const t = query.departAt + seconds;
      if (t < best[to]!) {
        start.arrival[to] = t;
        start.kind[to] = WALK;
        start.walkFrom[to] = s;
        best[to] = t;
        marked.add(to);
      }
    }
  }

  const bestAtTarget = (): number => Math.min(...[...targets].map((s) => best[s]!));

  for (let k = 1; k <= query.maxTransfers + 1 && marked.size > 0; k++) {
    const previous = rounds[k - 1]!;
    const current = labels(n, previous);
    rounds.push(current);

    // 1. Each pattern serving an improved stop, from its first such stop.
    const queue = new Map<number, number>();
    for (const stop of marked) {
      for (const { pattern, position } of tt.stopPatterns[stop]!) {
        const known = queue.get(pattern);
        if (known === undefined || position < known) queue.set(pattern, position);
      }
    }
    marked = new Set();

    // 2. Scan the patterns.
    let targetBound = bestAtTarget();
    for (const [p, from] of queue) {
      const pattern = tt.patterns[p]!;
      let trip = -1;
      let boardPosition = -1;
      for (let i = from; i < pattern.stops.length; i++) {
        const stop = pattern.stops[i]!;
        if (trip >= 0 && pattern.canAlight[i]) {
          const t = arrival(pattern, trip, i);
          // Target pruning: an arrival later than the best known at the destination is useless.
          if (t < best[stop]! && t < targetBound) {
            current.arrival[stop] = t;
            current.kind[stop] = RIDE;
            current.pattern[stop] = p;
            current.trip[stop] = trip;
            current.boardPosition[stop] = boardPosition;
            current.alightPosition[stop] = i;
            best[stop] = t;
            marked.add(stop);
            if (targets.has(stop)) targetBound = Math.min(targetBound, t);
          }
        }
        // Could an earlier trip be caught here, having arrived in the previous round?
        const ready = previous.arrival[stop]!;
        if (pattern.canBoard[i] && ready < Infinity && (trip < 0 || ready <= departure(pattern, trip, i))) {
          const earlier = earliestTrip(tt, p, i, ready);
          if (earlier >= 0 && (trip < 0 || earlier < trip)) {
            trip = earlier;
            boardPosition = i;
          }
        }
      }
    }

    // 3. Walk from the stops a vehicle improved (one walk at a time, not chains of walks).
    targetBound = bestAtTarget();
    for (const stop of [...marked]) {
      for (const { to, seconds } of tt.footpaths[stop]!) {
        const t = current.arrival[stop]! + seconds;
        if (t < best[to]! && t < targetBound) {
          current.arrival[to] = t;
          current.kind[to] = WALK;
          current.walkFrom[to] = stop;
          best[to] = t;
          marked.add(to);
        }
      }
    }
  }

  // One journey per round that beats every round with fewer vehicles.
  const journeys: Journey[] = [];
  let bestSoFar = Infinity;
  for (let k = 1; k < rounds.length; k++) {
    let target = -1;
    for (const s of targets) {
      const t = rounds[k]!.arrival[s]!;
      if (t < bestSoFar && (target < 0 || t < rounds[k]!.arrival[target]!)) target = s;
    }
    if (target < 0) continue;
    bestSoFar = rounds[k]!.arrival[target]!;
    journeys.push(reconstruct(tt, rounds, k, target));
  }
  return journeys;
}

function reconstruct(tt: Timetable, rounds: Labels[], round: number, target: number): Journey {
  const legs: Leg[] = [];
  let k = round;
  let stop = target;
  for (;;) {
    const l = rounds[k]!;
    const kind = l.kind[stop]!;
    if (kind === NONE) {
      k--; // reached in an earlier round and carried over
      continue;
    }
    if (kind === ORIGIN) break;
    if (kind === WALK) {
      const from = l.walkFrom[stop]!;
      const fromArrival = l.arrival[from]!;
      legs.push({ kind: "walk", from, to: stop, departure: fromArrival, arrival: l.arrival[stop]! });
      stop = from;
      continue;
    }
    const pattern = tt.patterns[l.pattern[stop]!]!;
    const trip = l.trip[stop]!;
    const board = l.boardPosition[stop]!;
    const alight = l.alightPosition[stop]!;
    const t = pattern.trips[trip]!;
    legs.push({
      kind: "ride",
      routeId: pattern.routeId,
      tripId: t.id,
      headsign: t.headsign,
      from: pattern.stops[board]!,
      to: stop,
      departure: departure(pattern, trip, board),
      arrival: arrival(pattern, trip, alight),
      stopCount: alight - board,
    });
    stop = pattern.stops[board]!;
    k--;
  }
  legs.reverse();
  // A walk before the first vehicle can start as late as still catches it, not at the query
  // time: "leave at 08:12" is what a traveller wants to know.
  const [first, second] = legs;
  if (first?.kind === "walk" && second?.kind === "ride") {
    const duration = first.arrival - first.departure;
    legs[0] = { ...first, departure: second.departure - duration, arrival: second.departure };
  }
  const rides = legs.filter((leg): leg is RideLeg => leg.kind === "ride");
  return {
    legs,
    departure: legs[0]?.departure ?? 0,
    arrival: legs[legs.length - 1]?.arrival ?? 0,
    transfers: Math.max(0, rides.length - 1),
  };
}

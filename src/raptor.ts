/**
 * RAPTOR: Round-bAsed Public Transit Optimized Router, and its range variant rRAPTOR.
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
 * vehicles: "arrive 08:41 with 1 transfer, or 08:36 with 2".
 *
 * rRAPTOR answers "all good journeys leaving between 08:00 and 09:00": it runs RAPTOR once for
 * every departure from the origin in that window, from the latest to the earliest, *without
 * resetting the labels*. Whatever a later departure reached stays as a bound, so an earlier
 * departure only produces a journey where it arrives earlier, and each run prunes most of the
 * network. The result is a profile: the Pareto set over a later departure, an earlier arrival
 * and fewer transfers. For that to be right, a label is only compared with labels of its own
 * round (a later departure with more vehicles must not hide an earlier one with fewer).
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
  /**
   * Also consider departures up to this many seconds after departAt (rRAPTOR). With 0 (the
   * default) the journeys leave as early as possible from departAt.
   */
  readonly window?: number;
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

function labels(n: number): Labels {
  return {
    arrival: new Float64Array(n).fill(Infinity),
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

/**
 * The labels of one query, kept across runs: run(t) for a later t first, then earlier ones.
 * Each run returns the journeys it improved: at most one per number of vehicles.
 */
export class Search {
  private readonly rounds: Labels[];
  private readonly targets: Set<number>;

  constructor(
    private readonly tt: Timetable,
    private readonly query: Query,
  ) {
    const n = tt.feed.stops.length;
    this.rounds = Array.from({ length: query.maxTransfers + 2 }, () => labels(n));
    this.targets = new Set(query.to);
  }

  run(departAt: number): Journey[] {
    const { tt, query, rounds, targets } = this;
    if (query.from.length === 0 || targets.size === 0 || query.from.some((s) => targets.has(s))) return [];
    const n = tt.feed.stops.length;
    let marked = new Set<number>();

    // Round 0: being at the origin, and walking from there.
    const start = rounds[0]!;
    for (const s of query.from) {
      if (departAt < start.arrival[s]!) {
        start.arrival[s] = departAt;
        start.kind[s] = ORIGIN;
        marked.add(s);
      }
    }
    for (const s of query.from) {
      for (const { to, seconds } of tt.footpaths[s]!) {
        const t = departAt + seconds;
        if (t < start.arrival[to]!) {
          start.arrival[to] = t;
          start.kind[to] = WALK;
          start.walkFrom[to] = s;
          marked.add(to);
        }
      }
    }

    const improvedRounds: number[] = [];
    for (let k = 1; k < rounds.length && marked.size > 0; k++) {
      const previous = rounds[k - 1]!;
      const current = rounds[k]!;
      // With k vehicles one is never later than with k - 1.
      for (let p = 0; p < n; p++) {
        if (previous.arrival[p]! < current.arrival[p]!) {
          current.arrival[p] = previous.arrival[p]!;
          current.kind[p] = NONE;
        }
      }
      const targetBefore = this.bestTarget(current);

      // 1. Each pattern serving an improved stop, from its first such stop.
      const queue = new Map<number, number>();
      for (const stop of marked) {
        for (const { pattern, position } of tt.stopPatterns[stop]!) {
          const known = queue.get(pattern);
          if (known === undefined || position < known) queue.set(pattern, position);
        }
      }
      marked = new Set();

      // 2. Scan the patterns. Target pruning: an arrival no earlier than the best known at the
      // destination (in this round) can't lead to a better journey.
      let targetBound = targetBefore;
      for (const [p, from] of queue) {
        const pattern = tt.patterns[p]!;
        let trip = -1;
        let boardPosition = -1;
        for (let i = from; i < pattern.stops.length; i++) {
          const stop = pattern.stops[i]!;
          if (trip >= 0 && pattern.canAlight[i]) {
            const t = arrival(pattern, trip, i);
            if (t < current.arrival[stop]! && t < targetBound) {
              current.arrival[stop] = t;
              current.kind[stop] = RIDE;
              current.pattern[stop] = p;
              current.trip[stop] = trip;
              current.boardPosition[stop] = boardPosition;
              current.alightPosition[stop] = i;
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
      for (const stop of [...marked]) {
        for (const { to, seconds } of tt.footpaths[stop]!) {
          const t = current.arrival[stop]! + seconds;
          if (t < current.arrival[to]! && t < targetBound) {
            current.arrival[to] = t;
            current.kind[to] = WALK;
            current.walkFrom[to] = stop;
            marked.add(to);
            if (targets.has(to)) targetBound = Math.min(targetBound, t);
          }
        }
      }
      if (this.bestTarget(current) < targetBefore) improvedRounds.push(k);
    }

    return improvedRounds.map((k) => reconstruct(tt, rounds, k, this.bestTargetStop(rounds[k]!)));
  }

  private bestTarget(l: Labels): number {
    let best = Infinity;
    for (const s of this.targets) best = Math.min(best, l.arrival[s]!);
    return best;
  }

  private bestTargetStop(l: Labels): number {
    let best = -1;
    for (const s of this.targets) if (best < 0 || l.arrival[s]! < l.arrival[best]!) best = s;
    return best;
  }
}

/**
 * The times worth starting at: every departure in [departAt, departAt + window] from an origin
 * stop, or from a stop one can walk to from there (minus the walk), latest first. departAt itself
 * comes last, so the next journey is found even when nothing leaves in the window.
 */
export function departureTimes(tt: Timetable, query: Query): number[] {
  const from = query.departAt;
  const until = from + (query.window ?? 0);
  const times = new Set<number>([from]);
  const add = (stop: number, walk: number) => {
    for (const { pattern, position } of tt.stopPatterns[stop]!) {
      const p = tt.patterns[pattern]!;
      if (!p.canBoard[position]) continue;
      for (let t = 0; t < p.trips.length; t++) {
        const leave = departure(p, t, position) - walk;
        if (leave >= from && leave <= until) times.add(leave);
      }
    }
  };
  for (const s of query.from) {
    add(s, 0);
    for (const { to, seconds } of tt.footpaths[s]!) add(to, seconds);
  }
  return [...times].sort((a, b) => b - a);
}

/** True if `a` is at least as good as `b` in departure, arrival and transfers, and better in one. */
function dominates(a: Journey, b: Journey): boolean {
  const asGood = a.departure >= b.departure && a.arrival <= b.arrival && a.transfers <= b.transfers;
  const better = a.departure > b.departure || a.arrival < b.arrival || a.transfers < b.transfers;
  return asGood && better;
}

/**
 * Every journey worth taking in the window: none leaves earlier, arrives later and changes more
 * often than another one. Sorted by departure. Journeys leaving after the window are only kept
 * when nothing leaves inside it.
 */
export function profile(tt: Timetable, query: Query): Journey[] {
  const search = new Search(tt, query);
  const found: Journey[] = [];
  for (const t of departureTimes(tt, query)) found.push(...search.run(t));
  const pareto = found.filter((j, i) => !found.some((other, o) => (o !== i && dominates(other, j)) || (o < i && same(other, j))));
  const until = query.departAt + (query.window ?? 0);
  const inside = pareto.filter((j) => j.departure <= until);
  return (inside.length > 0 ? inside : pareto).sort((a, b) => a.departure - b.departure || a.arrival - b.arrival);
}

function same(a: Journey, b: Journey): boolean {
  return a.departure === b.departure && a.arrival === b.arrival && a.transfers === b.transfers;
}

/**
 * The best journey for each number of transfers that beats every journey with fewer: the
 * earliest arrival. With a window, it also leaves as late as possible: the profile has already
 * dropped every journey that arrives at the same time but leaves earlier (it is dominated), so
 * one isn't told to leave earlier than needed. Useless detours are dropped (see withoutDetours).
 */
export function plan(tt: Timetable, query: Query): Journey[] {
  const candidates = (query.window ?? 0) > 0 ? profile(tt, query) : new Search(tt, query).run(query.departAt);
  const byTransfers = new Map<number, Journey>();
  for (const j of candidates) {
    const known = byTransfers.get(j.transfers);
    if (!known || j.arrival < known.arrival) byTransfers.set(j.transfers, j);
  }
  const journeys: Journey[] = [];
  let bestSoFar = Infinity;
  for (const j of [...byTransfers.values()].sort((a, b) => a.transfers - b.transfers)) {
    if (j.arrival < bestSoFar) {
      journeys.push(j);
      bestSoFar = j.arrival;
    }
  }
  return withoutDetours(journeys, query.departAt);
}

/**
 * Drop journeys that are Pareto-optimal but useless: "direct, but arriving 17 hours later than
 * with one change" (the first night bus). A journey is kept if it arrives at most
 * max(30 min, the fastest journey's travel time) after the fastest one.
 */
export function withoutDetours(journeys: Journey[], departAt: number): Journey[] {
  if (journeys.length === 0) return journeys;
  const fastest = Math.min(...journeys.map((j) => j.arrival));
  const slack = Math.max(30 * 60, fastest - departAt);
  return journeys.filter((j) => j.arrival <= fastest + slack);
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

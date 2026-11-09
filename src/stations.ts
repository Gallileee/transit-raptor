/**
 * Changes inside stations, from pathways.txt.
 *
 * A metro station in GTFS is a small graph: each platform has *boarding areas* (spots along the
 * platform, location_type 4, whose parent is the platform), and pathways connect boarding areas,
 * corridor nodes (3) and entrances (2) with walkways, stairs, escalators and elevators. Escalators
 * usually go one way, so the graph is directed: going up can take longer than coming down.
 *
 * A change between two platforms is the shortest path through that graph (Dijkstra), and one
 * from a platform to a stop on the street goes out through the best entrance and then walks.
 * Two choices model the passenger, not the graph:
 *
 * - Getting off, one is wherever one's carriage stopped, so the time is the *average* over the
 *   platform's boarding areas. Getting on, one walks to the nearest part of the platform, so the
 *   *shortest* over the target's boarding areas counts.
 * - A fixed buffer (StationOptions.bufferSeconds) is added for getting off, finding the way and
 *   being at the doors before they close.
 *
 * Checked against the official PID planner (IDOS) on 10 Nov 2026; see PROGRESS.md.
 */
import { distanceMetres } from "./geo.js";
import type { Feed, Pathway } from "./gtfs.js";
import type { WalkOptions } from "./timetable.js";

export interface StationOptions {
  /** Walking speed inside stations (corridors are mapped, so no detour factor), m/s. */
  readonly speed: number;
  /** Seconds per stair, on top of the horizontal distance. */
  readonly secondsPerStair: number;
  /** An elevator without traversal_time, including waiting for it. */
  readonly elevatorSeconds: number;
  /** Added to every change: getting off, finding the way, being at the doors in time. */
  readonly bufferSeconds: number;
}

/**
 * The buffer is the only number not taken from the feed. Three changes checked against IDOS on
 * 10 Nov 2026 bound it: Mustek B->A (146 s of path; IDOS rejects a 175 s change, so >= 29 s),
 * Nadrazi Veleslavin metro->trolleybus 59 (125 s of path; IDOS allows 180 s, so <= 55 s) and
 * Muzeum A->C (144 s; allowed 225 s, so <= 81 s). 45 s is the middle of 29-55.
 */
export const DEFAULT_STATION: StationOptions = {
  speed: 1.2,
  secondsPerStair: 0.6,
  elevatorSeconds: 60,
  bufferSeconds: 45,
};

interface Edge {
  readonly to: number;
  readonly seconds: number;
}

/** Seconds to walk one pathway from `from` to `to`. */
export function pathwaySeconds(feed: Feed, p: Pathway, from: number, to: number, options: StationOptions): number {
  if (p.seconds !== undefined) return p.seconds;
  if (p.mode === 5) return options.elevatorSeconds;
  const a = feed.stops[from]!;
  const b = feed.stops[to]!;
  const flat = distanceMetres(a.lat, a.lon, b.lat, b.lon) / options.speed;
  return flat + (p.mode === 2 ? p.stairs * options.secondsPerStair : 0);
}

/** The directed graph, both ways round (reversed edges answer "how long from X to here"). */
function buildGraphs(feed: Feed, options: StationOptions): { forward: Edge[][]; backward: Edge[][] } {
  const forward: Edge[][] = feed.stops.map(() => []);
  const backward: Edge[][] = feed.stops.map(() => []);
  const add = (from: number, to: number, seconds: number) => {
    forward[from]!.push({ to, seconds });
    backward[to]!.push({ to: from, seconds });
  };
  for (const p of feed.pathways) {
    add(p.from, p.to, pathwaySeconds(feed, p, p.from, p.to, options));
    if (p.bidirectional) add(p.to, p.from, pathwaySeconds(feed, p, p.to, p.from, options));
  }
  return { forward, backward };
}

/** Shortest times from `source` to every node it reaches. */
export function dijkstra(graph: readonly Edge[][], source: number): Map<number, number> {
  const dist = new Map<number, number>([[source, 0]]);
  const heap = new MinHeap();
  heap.push(0, source);
  for (let top = heap.pop(); top !== undefined; top = heap.pop()) {
    const [t, node] = top;
    if (t > dist.get(node)!) continue; // an outdated entry
    for (const { to, seconds } of graph[node]!) {
      const next = t + seconds;
      if (next < (dist.get(to) ?? Infinity)) {
        dist.set(to, next);
        heap.push(next, to);
      }
    }
  }
  return dist;
}

/** A binary min-heap of (key, value) pairs. */
export class MinHeap {
  private readonly keys: number[] = [];
  private readonly values: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, value: number): void {
    this.keys.push(key);
    this.values.push(value);
    let i = this.keys.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent]! <= key) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): [number, number] | undefined {
    if (this.keys.length === 0) return undefined;
    const top: [number, number] = [this.keys[0]!, this.values[0]!];
    const lastKey = this.keys.pop()!;
    const lastValue = this.values.pop()!;
    if (this.keys.length > 0) {
      this.keys[0] = lastKey;
      this.values[0] = lastValue;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < this.keys.length && this.keys[l]! < this.keys[smallest]!) smallest = l;
        if (r < this.keys.length && this.keys[r]! < this.keys[smallest]!) smallest = r;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    [this.keys[a], this.keys[b]] = [this.keys[b]!, this.keys[a]!];
    [this.values[a], this.values[b]] = [this.values[b]!, this.values[a]!];
  }
}

export interface StationTransfer {
  readonly from: number;
  readonly to: number;
  readonly seconds: number;
}

/**
 * Change times for every station that has pathways: platform to platform (within the station),
 * platform to street stops near an entrance, and street stops to platforms.
 */
export function stationTransfers(
  feed: Feed,
  walk: WalkOptions,
  options: StationOptions = DEFAULT_STATION,
): StationTransfer[] {
  if (feed.pathways.length === 0) return [];
  const { forward, backward } = buildGraphs(feed, options);

  // Boarding areas of each platform, entrances of each station.
  const areas = new Map<number, number[]>();
  const entrances = new Map<string, number[]>();
  for (const stop of feed.stops) {
    if (stop.locationType === 4) {
      const platform = feed.stopById.get(stop.parent);
      if (platform !== undefined) areas.set(platform, [...(areas.get(platform) ?? []), stop.index]);
    } else if (stop.locationType === 2 && stop.parent) {
      entrances.set(stop.parent, [...(entrances.get(stop.parent) ?? []), stop.index]);
    }
  }

  const streetStops = feed.stops.filter((s) => s.locationType === 0 && !areas.has(s.index));
  const surface = (from: number, to: number): number | undefined => {
    const a = feed.stops[from]!;
    const b = feed.stops[to]!;
    const metres = distanceMetres(a.lat, a.lon, b.lat, b.lon);
    return metres <= walk.maxMetres ? (metres * walk.detour) / walk.speed : undefined;
  };

  const result: StationTransfer[] = [];
  const byStation = new Map<string, number[]>();
  for (const platform of areas.keys()) {
    const station = feed.stops[platform]!.parent;
    byStation.set(station, [...(byStation.get(station) ?? []), platform]);
  }

  for (const [station, platforms] of byStation) {
    const exits = entrances.get(station) ?? [];
    // Street stops near any entrance of this station.
    const nearby = streetStops.filter((s) => exits.some((e) => surface(e, s.index) !== undefined));

    for (const from of platforms) {
      const starts = areas.get(from)!;
      const fromStarts = starts.map((a) => dijkstra(forward, a));
      const average = (cost: (dist: Map<number, number>) => number): number =>
        fromStarts.reduce((sum, dist) => sum + cost(dist), 0) / fromStarts.length;

      for (const to of platforms) {
        if (to === from) continue;
        const targets = areas.get(to)!;
        const seconds = average((dist) => Math.min(...targets.map((t) => dist.get(t) ?? Infinity)));
        if (Number.isFinite(seconds)) result.push({ from, to, seconds: Math.ceil(seconds + options.bufferSeconds) });
      }
      for (const stop of nearby) {
        const seconds = average((dist) =>
          Math.min(...exits.map((e) => (dist.get(e) ?? Infinity) + (surface(e, stop.index) ?? Infinity))),
        );
        if (Number.isFinite(seconds)) {
          result.push({ from, to: stop.index, seconds: Math.ceil(seconds + options.bufferSeconds) });
        }
      }
    }

    // From the street onto a platform: the nearest entrance, then the nearest boarding area.
    for (const to of platforms) {
      const fromEntrance = new Map<number, number>();
      for (const area of areas.get(to)!) {
        for (const [node, seconds] of dijkstra(backward, area)) {
          if (exits.includes(node) && seconds < (fromEntrance.get(node) ?? Infinity)) fromEntrance.set(node, seconds);
        }
      }
      for (const stop of nearby) {
        const seconds = Math.min(
          ...[...fromEntrance].map(([e, inside]) => (surface(stop.index, e) ?? Infinity) + inside),
        );
        if (Number.isFinite(seconds)) {
          result.push({ from: stop.index, to, seconds: Math.ceil(seconds + options.bufferSeconds) });
        }
      }
    }
  }
  return result;
}

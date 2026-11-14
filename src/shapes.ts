/**
 * The street geometry of trips, from shapes.txt, for drawing a ride on the map.
 *
 * A shape is a polyline; trips.txt says which shape a trip follows. To draw only the part
 * between where one gets on and where one gets off, the stops have to be placed on the line:
 *
 * - With shape_dist_traveled (in both stop_times.txt and shapes.txt, in the same unit), a stop
 *   is a distance along the line, and the part between two distances is cut out directly.
 * - Without it, each stop is projected onto the nearest segment, the second one only after
 *   the first, so a route that comes back past its start isn't drawn backwards.
 *
 * Either way the result is checked: if a cut end lies far from its stop (a broken shape, a
 * different unit), there is no path and the caller draws straight lines between stops.
 *
 * Shapes don't depend on the date, so they are loaded once (Prague: 3.3 M points, ~0.7 s to
 * read) and kept compactly: coordinates as whole micro-degrees, distances as 32-bit floats.
 *
 * Spec: https://gtfs.org/documentation/schedule/reference/#shapestxt
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readCsv } from "./csv.js";
import { FeedError } from "./gtfs.js";
import { distanceMetres } from "./geo.js";

export type LatLon = [number, number];

export interface Shape {
  /** Micro-degrees (degrees x 1e6, rounded): exact for feeds with 6 decimals, 4 bytes each. */
  readonly lat: Int32Array;
  readonly lon: Int32Array;
  /** shape_dist_traveled of each point, or NaN where the feed has none. */
  readonly dist: Float32Array;
  /** True when every point has a distance and they never decrease. */
  readonly measured: boolean;
}

/** A stop to place on a shape: where it is, and its shape_dist_traveled (NaN if unknown). */
export interface StopOnShape {
  readonly lat: number;
  readonly lon: number;
  readonly dist: number;
}

/** A cut end may be this far from its stop; further means the shape doesn't fit. */
export const MAX_OFFSET_METRES = 150;

const MICRO = 1e6;

/**
 * Collects points in file order into growing typed arrays, then groups them by shape and
 * sequence. A first version kept a JS number array per shape: for Prague that peaked about
 * 250 MB above the 45 MB the shapes finally take; typed columns need about 24 bytes a point.
 */
class ShapeBuilder {
  private readonly ids = new Map<string, number>();
  private readonly counts: number[] = [];
  private n = 0;
  private shapeOf = new Int32Array(1024);
  private sequence = new Float64Array(1024);
  private lat = new Int32Array(1024);
  private lon = new Int32Array(1024);
  private dist = new Float32Array(1024);

  add(id: string, sequence: number, lat: number, lon: number, dist: number): void {
    if (this.n === this.lat.length) this.grow();
    let shape = this.ids.get(id);
    if (shape === undefined) {
      shape = this.counts.length;
      this.ids.set(id, shape);
      this.counts.push(0);
    }
    this.counts[shape]!++;
    const i = this.n++;
    this.shapeOf[i] = shape;
    this.sequence[i] = sequence;
    this.lat[i] = Math.round(lat * MICRO);
    this.lon[i] = Math.round(lon * MICRO);
    this.dist[i] = dist;
  }

  private grow(): void {
    const size = this.lat.length * 2;
    const bigger = <T extends Int32Array | Float32Array | Float64Array>(old: T, make: (n: number) => T): T => {
      const array = make(size);
      array.set(old);
      return array;
    };
    this.shapeOf = bigger(this.shapeOf, (n) => new Int32Array(n));
    this.sequence = bigger(this.sequence, (n) => new Float64Array(n));
    this.lat = bigger(this.lat, (n) => new Int32Array(n));
    this.lon = bigger(this.lon, (n) => new Int32Array(n));
    this.dist = bigger(this.dist, (n) => new Float32Array(n));
  }

  shapes(): Shapes {
    return Shapes.fromColumns(this.build());
  }

  build(): ShapeColumns {
    const { n, counts } = this;
    // Counting sort by shape (keeps file order within a shape) ...
    const start = new Int32Array(counts.length + 1);
    counts.forEach((count, k) => (start[k + 1] = start[k]! + count));
    const next = start.slice(0, counts.length);
    const order = new Int32Array(n);
    for (let i = 0; i < n; i++) order[next[this.shapeOf[i]!]!++] = i;
    // ... then by shape_pt_sequence, only where a shape's rows aren't in order already.
    for (let k = 0; k < counts.length; k++) {
      const part = order.subarray(start[k]!, start[k + 1]!);
      if (part.some((row, j) => j > 0 && this.sequence[row]! < this.sequence[part[j - 1]!]!)) {
        part.set(Array.from(part).sort((a, b) => this.sequence[a]! - this.sequence[b]!));
      }
    }
    const lat = new Int32Array(n);
    const lon = new Int32Array(n);
    const dist = new Float32Array(n);
    order.forEach((from, to) => {
      lat[to] = this.lat[from]!;
      lon[to] = this.lon[from]!;
      dist[to] = this.dist[from]!;
    });
    return { ids: [...this.ids.keys()], start, lat, lon, dist };
  }
}

/**
 * All shapes of a feed in five columns: the points of shape `ids[k]` are rows
 * `start[k] .. start[k + 1] - 1`. This is also how the cache stores them.
 */
export interface ShapeColumns {
  readonly ids: string[];
  readonly start: Int32Array;
  readonly lat: Int32Array;
  readonly lon: Int32Array;
  readonly dist: Float32Array;
}

export class Shapes {
  private readonly byId = new Map<string, Shape>();

  private constructor(readonly columns: ShapeColumns) {
    const { ids, start, lat, lon, dist } = columns;
    ids.forEach((id, k) => {
      const [s, e] = [start[k]!, start[k + 1]!];
      const d = dist.subarray(s, e);
      const measured = d.every((x, j) => !Number.isNaN(x) && (j === 0 || x >= d[j - 1]!));
      this.byId.set(id, { lat: lat.subarray(s, e), lon: lon.subarray(s, e), dist: d, measured });
    });
  }

  static readonly empty = new Shapes({
    ids: [],
    start: new Int32Array(1),
    lat: new Int32Array(0),
    lon: new Int32Array(0),
    dist: new Float32Array(0),
  });

  /** Read shapes.txt from a feed directory; a feed without one has no shapes. */
  static async load(dir: string): Promise<Shapes> {
    const file = join(dir, "shapes.txt");
    if (!existsSync(file)) return Shapes.empty;
    const builder = new ShapeBuilder();
    await readCsv(file, (row) => {
      const id = row("shape_id");
      const sequence = Number(row("shape_pt_sequence"));
      const lat = Number(row("shape_pt_lat"));
      const lon = Number(row("shape_pt_lon"));
      if (!id || !Number.isFinite(sequence) || !Number.isFinite(lat) || !Number.isFinite(lon)) {
        throw new FeedError(`shapes.txt: bad row for shape "${id}"`);
      }
      const text = row("shape_dist_traveled");
      builder.add(id, sequence, lat, lon, text === "" ? NaN : Number(text));
    });
    return builder.shapes();
  }

  /** Shapes built in memory, for tests: points as [lat, lon] or [lat, lon, dist]. */
  static of(shapes: Record<string, number[][]>): Shapes {
    const builder = new ShapeBuilder();
    for (const [id, points] of Object.entries(shapes)) {
      points.forEach(([lat, lon, dist], i) => builder.add(id, i, lat!, lon!, dist ?? NaN));
    }
    return builder.shapes();
  }

  /** Shapes from columns saved earlier (the cache); the columns are checked, not trusted. */
  static fromColumns(columns: ShapeColumns): Shapes {
    const { ids, start, lat, lon, dist } = columns;
    const n = lat.length;
    const ok =
      start.length === ids.length + 1 &&
      start[0] === 0 &&
      start[ids.length] === n &&
      lon.length === n &&
      dist.length === n &&
      start.every((s, k) => k === 0 || s >= start[k - 1]!);
    if (!ok) throw new FeedError("shape columns don't fit together");
    return new Shapes(columns);
  }

  get(id: string): Shape | undefined {
    return id ? this.byId.get(id) : undefined;
  }

  get size(): number {
    return this.byId.size;
  }
}

function pointAt(shape: Shape, i: number): LatLon {
  return [shape.lat[i]! / MICRO, shape.lon[i]! / MICRO];
}

/** The point a fraction `t` (0..1) of the way along segment i -> i + 1. */
function along(shape: Shape, i: number, t: number): LatLon {
  if (t <= 0 || i + 1 >= shape.lat.length) return pointAt(shape, i);
  const [lat0, lon0] = pointAt(shape, i);
  const [lat1, lon1] = pointAt(shape, i + 1);
  return [round(lat0 + (lat1 - lat0) * t), round(lon0 + (lon1 - lon0) * t)];
}

function round(degrees: number): number {
  return Math.round(degrees * MICRO) / MICRO;
}

/** A place on the line: segment index and how far into it (0..1). */
interface Position {
  readonly segment: number;
  readonly t: number;
}

/** Where distance `d` lies, by binary search over the measured points. */
export function positionAtDistance(shape: Shape, d: number): Position | undefined {
  const n = shape.dist.length;
  if (n < 2 || !(d >= shape.dist[0]! - 1e-6) || !(d <= shape.dist[n - 1]! + 1e-6)) return undefined;
  let lo = 0;
  let hi = n - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (shape.dist[mid]! <= d) lo = mid;
    else hi = mid - 1;
  }
  const length = shape.dist[lo + 1]! - shape.dist[lo]!;
  return { segment: lo, t: length > 0 ? Math.min(1, Math.max(0, (d - shape.dist[lo]!) / length)) : 0 };
}

/**
 * The nearest place on the line to a point, looking only at or after `after` (so the second
 * stop of a ride is never placed before the first). Distances are compared in a flat
 * projection around the point, which is plenty for the few hundred metres that matter here.
 */
export function project(shape: Shape, lat: number, lon: number, after: Position = { segment: 0, t: 0 }): Position {
  const kx = Math.cos((lat * Math.PI) / 180);
  let best: Position = after;
  let bestSquared = Infinity;
  for (let i = after.segment; i + 1 < shape.lat.length; i++) {
    const ax = (shape.lon[i]! / MICRO - lon) * kx;
    const ay = shape.lat[i]! / MICRO - lat;
    const bx = (shape.lon[i + 1]! / MICRO - lon) * kx;
    const by = shape.lat[i + 1]! / MICRO - lat;
    const dx = bx - ax;
    const dy = by - ay;
    const length = dx * dx + dy * dy;
    let t = length > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / length)) : 0;
    if (i === after.segment) t = Math.max(t, after.t);
    const x = ax + dx * t;
    const y = ay + dy * t;
    const squared = x * x + y * y;
    if (squared < bestSquared) {
      bestSquared = squared;
      best = { segment: i, t };
    }
  }
  return best;
}

/** The line from one position to a later one: both cut ends and every shape point between. */
function slice(shape: Shape, from: Position, to: Position): LatLon[] {
  const path: LatLon[] = [along(shape, from.segment, from.t)];
  for (let i = from.segment + 1; i <= to.segment; i++) path.push(pointAt(shape, i));
  path.push(along(shape, to.segment, to.t));
  // Drop repeated points (a cut exactly on a shape point).
  return path.filter((p, i) => i === 0 || p[0] !== path[i - 1]![0] || p[1] !== path[i - 1]![1]);
}

function before(a: Position, b: Position): boolean {
  return a.segment < b.segment || (a.segment === b.segment && a.t <= b.t);
}

/**
 * The part of a shape between two stops of a ride, or undefined when it can't be placed
 * convincingly (then straight lines between the stops are the honest drawing).
 */
export function cut(shape: Shape, from: StopOnShape, to: StopOnShape): LatLon[] | undefined {
  if (shape.lat.length < 2) return undefined;
  let start: Position | undefined;
  let end: Position | undefined;
  if (shape.measured && Number.isFinite(from.dist) && Number.isFinite(to.dist) && from.dist <= to.dist) {
    start = positionAtDistance(shape, from.dist);
    end = positionAtDistance(shape, to.dist);
  }
  if (start === undefined || end === undefined || !fits(shape, start, from) || !fits(shape, end, to)) {
    start = project(shape, from.lat, from.lon);
    end = project(shape, to.lat, to.lon, start);
    if (!fits(shape, start, from) || !fits(shape, end, to)) return undefined;
  }
  if (!before(start, end)) return undefined;
  return slice(shape, start, end);
}

function fits(shape: Shape, position: Position, stop: StopOnShape): boolean {
  const [lat, lon] = along(shape, position.segment, position.t);
  return distanceMetres(lat, lon, stop.lat, stop.lon) <= MAX_OFFSET_METRES;
}

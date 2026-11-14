/**
 * A binary cache of the compiled feed and its shapes, so a restart doesn't parse 300 MB of CSV.
 *
 * Reading Prague's feed takes ~2.7 s, nearly all of it splitting lines and turning text into
 * numbers. What comes out is mostly a few large typed arrays (stop times, shape points), which
 * can be written to disk as they are and read back with no parsing at all. The rest (stops,
 * routes, trips, calendar) is small enough for JSON.
 *
 * File layout, all numbers little-endian:
 *
 *   "TRCACHE\0"            8 bytes, magic
 *   format                 uint32 (FORMAT below; bumped whenever the layout or meaning changes)
 *   header length          uint32
 *   crc32                  uint32 of everything after these 20 bytes
 *   zero                   uint32
 *   header                 JSON: fingerprint, the small tables, and where each array is
 *   padding, then arrays   each starting at a multiple of 8, so it can be used in place
 *
 * The fingerprint lists every feed file's size and modification time: a new download changes
 * it and the cache is rebuilt. Anything wrong with the file (another format, a different
 * fingerprint, a bad checksum, a cut-off file) means "no cache": the CSV files are read and
 * the cache is written again. A cache that can't be written costs only the next start's time.
 */
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { endianness } from "node:os";
import { join, resolve } from "node:path";
import { crc32 } from "node:zlib";
import {
  type Access,
  type Calendar,
  type CompiledFeed,
  type CompiledTrip,
  compileFeed,
  FEED_FILES,
  type Pathway,
  type Route,
  type Stop,
} from "./gtfs.js";
import { Shapes } from "./shapes.js";

export const FORMAT = 1;
const MAGIC = Buffer.from("TRCACHE\0", "latin1");
const PREFIX = 24;

export class CacheError extends Error {}

/** The compiled feed and its shapes: everything that doesn't depend on the date. */
export interface OpenedFeed {
  readonly compiled: CompiledFeed;
  readonly shapes: Shapes;
  /** Where it came from: the cache file, or the CSV files (then also written to the cache). */
  readonly source: "cache" | "csv";
}

export interface OpenOptions {
  /** Directory for the cache file; undefined = no cache. */
  readonly cacheDir?: string | undefined;
  readonly log?: (line: string) => void;
  /**
   * False when the caller has no use for shapes (the command line): then shapes.txt is only
   * read if a cache is being written, which should be complete. Default true.
   */
  readonly shapes?: boolean;
}

/** The default place for a feed's cache: a folder inside the feed directory. */
export function defaultCacheDir(gtfsDir: string): string {
  return join(gtfsDir, ".transit-raptor-cache");
}

/** One cache file per feed directory, so several feeds can share a cache folder. */
export function cacheFile(cacheDir: string, gtfsDir: string): string {
  const key = createHash("sha256").update(resolve(gtfsDir)).digest("hex").slice(0, 16);
  return join(cacheDir, `feed-${key}.bin`);
}

/** What the cache depends on: the format, the feed's path, and each file's size and time. */
export function fingerprint(gtfsDir: string): string {
  const parts = [`format ${FORMAT}`, resolve(gtfsDir)];
  for (const name of FEED_FILES) {
    const path = join(gtfsDir, name);
    if (!existsSync(path)) {
      parts.push(`${name} -`);
      continue;
    }
    const stat = statSync(path);
    parts.push(`${name} ${stat.size} ${Math.trunc(stat.mtimeMs)}`);
  }
  return parts.join("\n");
}

/**
 * Load a feed's compiled form: from the cache when it is there and up to date, otherwise from
 * the CSV files (and then save it). A broken shapes.txt costs the street drawing, not the
 * journeys: it is logged and the feed has no shapes.
 */
export async function openFeed(gtfsDir: string, options: OpenOptions = {}): Promise<OpenedFeed> {
  const log = options.log ?? (() => {});
  const file = options.cacheDir === undefined ? undefined : cacheFile(options.cacheDir, gtfsDir);
  const print = file === undefined ? "" : fingerprint(gtfsDir);
  if (file !== undefined && existsSync(file)) {
    const started = performance.now();
    try {
      const { compiled, shapes } = decode(await readFile(file), print);
      log(`cache: read ${file} in ${Math.round(performance.now() - started)} ms`);
      return { compiled, shapes, source: "cache" };
    } catch (e) {
      log(`cache: not used (${message(e)}), reading the feed`);
    }
  }
  const wantShapes = options.shapes !== false || file !== undefined;
  const [compiled, shapes] = await Promise.all([
    compileFeed(gtfsDir),
    wantShapes
      ? Shapes.load(gtfsDir).catch((e: unknown) => {
          log(`shapes.txt not used: ${message(e)}`);
          return Shapes.empty;
        })
      : Shapes.empty,
  ]);
  if (file !== undefined) {
    try {
      const bytes = encode(compiled, shapes, print);
      await mkdir(options.cacheDir!, { recursive: true });
      // Write next to it and rename: a reader never sees half a file, and two processes
      // writing at once just replace each other's complete file.
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, bytes);
      await rename(temporary, file).catch(async (e: unknown) => {
        await rm(temporary, { force: true });
        throw e;
      });
      log(`cache: wrote ${file} (${(bytes.length / 1e6).toFixed(1)} MB)`);
    } catch (e) {
      log(`cache: not written (${message(e)})`);
    }
  }
  return { compiled, shapes, source: "csv" };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type Kind = "i32" | "u8" | "f32";

interface Section {
  name: string;
  kind: Kind;
  length: number;
  offset: number; // from the start of the file
}

/** JSON can't hold undefined or NaN; tables are stored as tuples to keep the header small. */
interface Header {
  fingerprint: string;
  stops: [string, string, number, number, string, number, string, number | null, Access][];
  routes: [string, string, string, number, string, string][];
  calendar: Calendar;
  trips: [string, string, string, string, Access, string, number, number, string][];
  transfers: [number, number, number][];
  pathways: [number, number, number, boolean, number | null, number][];
  stats: CompiledFeed["stats"];
  shapeIds: string[];
  sections: Section[];
}

const BYTES: Record<Kind, number> = { i32: 4, u8: 1, f32: 4 };

export function encode(compiled: CompiledFeed, shapes: Shapes, print: string): Buffer {
  if (endianness() !== "LE") throw new CacheError("only little-endian machines are supported");
  const { columns } = compiled;
  const arrays: [string, Kind, Int32Array | Uint8Array | Float32Array][] = [
    ["stops", "i32", columns.stops],
    ["arrivals", "i32", columns.arrivals],
    ["departures", "i32", columns.departures],
    ["canBoard", "u8", columns.canBoard],
    ["canAlight", "u8", columns.canAlight],
    ["distances", "f32", columns.distances],
    ["shapeStart", "i32", shapes.columns.start],
    ["shapeLat", "i32", shapes.columns.lat],
    ["shapeLon", "i32", shapes.columns.lon],
    ["shapeDist", "f32", shapes.columns.dist],
  ];
  const header: Header = {
    fingerprint: print,
    stops: compiled.stops.map((s) => [
      s.id,
      s.name,
      s.lat,
      s.lon,
      s.parent,
      s.locationType,
      s.platform,
      s.level ?? null,
      s.wheelchair,
    ]),
    routes: compiled.routes.map((r) => [r.id, r.shortName, r.longName, r.type, r.color, r.textColor]),
    calendar: compiled.calendar,
    trips: compiled.trips.map((t) => [
      t.id,
      t.routeId,
      t.headsign,
      t.serviceId,
      t.wheelchair,
      t.shapeId,
      t.start,
      t.length,
      t.error,
    ]),
    transfers: compiled.transfers.map((t) => [t.from, t.to, t.seconds]),
    pathways: compiled.pathways.map((p) => [p.from, p.to, p.mode, p.bidirectional, p.seconds ?? null, p.stairs]),
    stats: compiled.stats,
    shapeIds: shapes.columns.ids,
    sections: [],
  };
  // The offsets depend on the header's length, which depends on the offsets: lay out the
  // arrays after a header measured with placeholder offsets, and pad it to that length.
  const placeholder = (n: number) => arrays.map(([name, kind, a]) => ({ name, kind, length: a.length, offset: n }));
  header.sections = placeholder(Number.MAX_SAFE_INTEGER);
  const room = align(PREFIX + Buffer.byteLength(JSON.stringify(header)));
  let offset = room;
  header.sections = arrays.map(([name, kind, array]) => {
    const section = { name, kind, length: array.length, offset };
    offset = align(offset + array.byteLength);
    return section;
  });
  const json = Buffer.from(JSON.stringify(header));
  const bytes = Buffer.alloc(offset);
  MAGIC.copy(bytes, 0);
  bytes.writeUInt32LE(FORMAT, 8);
  bytes.writeUInt32LE(json.length, 12);
  json.copy(bytes, PREFIX);
  arrays.forEach(([, , array], i) => {
    bytes.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), header.sections[i]!.offset);
  });
  bytes.writeUInt32LE(crc32(bytes.subarray(PREFIX)), 16);
  return bytes;
}

export function decode(bytes: Buffer, print: string): { compiled: CompiledFeed; shapes: Shapes } {
  if (bytes.length < PREFIX || !bytes.subarray(0, 8).equals(MAGIC)) throw new CacheError("not a cache file");
  const format = bytes.readUInt32LE(8);
  if (format !== FORMAT) throw new CacheError(`format ${format}, expected ${FORMAT}`);
  const headerLength = bytes.readUInt32LE(12);
  if (PREFIX + headerLength > bytes.length) throw new CacheError("file is cut off");
  if (crc32(bytes.subarray(PREFIX)) !== bytes.readUInt32LE(16)) throw new CacheError("checksum mismatch");
  const header = JSON.parse(bytes.subarray(PREFIX, PREFIX + headerLength).toString()) as Header;
  if (header.fingerprint !== print) throw new CacheError(`the feed changed since it was written`);

  const read = (name: string) => {
    const section = header.sections.find((s) => s.name === name);
    if (!section) throw new CacheError(`no ${name} in the file`);
    const size = section.length * BYTES[section.kind];
    if (section.offset % 8 !== 0 || section.offset + size > bytes.length) throw new CacheError(`${name} is out of bounds`);
    // A view into the file's memory when it lines up (large reads do); a copy otherwise.
    const at = bytes.byteOffset + section.offset;
    const buffer = at % 4 === 0 ? bytes.buffer : bytes.buffer.slice(at, at + size);
    const start = at % 4 === 0 ? at : 0;
    if (section.kind === "u8") return new Uint8Array(buffer, start, section.length);
    if (section.kind === "f32") return new Float32Array(buffer, start, section.length);
    return new Int32Array(buffer, start, section.length);
  };
  const int32 = (name: string) => expect(read(name), Int32Array, name);
  const uint8 = (name: string) => expect(read(name), Uint8Array, name);
  const float32 = (name: string) => expect(read(name), Float32Array, name);

  const columns = {
    stops: int32("stops"),
    arrivals: int32("arrivals"),
    departures: int32("departures"),
    canBoard: uint8("canBoard"),
    canAlight: uint8("canAlight"),
    distances: float32("distances"),
  };
  const rows = columns.stops.length;
  for (const [name, array] of Object.entries(columns)) {
    if (array.length !== rows) throw new CacheError(`${name} has ${array.length} rows, expected ${rows}`);
  }
  const stops: Stop[] = header.stops.map(
    ([id, name, lat, lon, parent, locationType, platform, level, wheelchair], index) => ({
      index,
      id,
      name,
      lat,
      lon,
      parent,
      locationType,
      platform,
      level: level ?? undefined,
      wheelchair,
    }),
  );
  const routes: Route[] = header.routes.map(([id, shortName, longName, type, color, textColor]) => ({
    id,
    shortName,
    longName,
    type,
    color,
    textColor,
  }));
  const trips: CompiledTrip[] = header.trips.map(
    ([id, routeId, headsign, serviceId, wheelchair, shapeId, start, length, error]) => {
      if (start < 0 || length < 0 || start + length > rows) throw new CacheError(`trip ${id} is out of bounds`);
      return { id, routeId, headsign, serviceId, wheelchair, shapeId, start, length, error };
    },
  );
  const pathways: Pathway[] = header.pathways.map(([from, to, mode, bidirectional, seconds, stairs]) => ({
    from,
    to,
    mode,
    bidirectional,
    seconds: seconds ?? undefined,
    stairs,
  }));
  for (let i = 0; i < rows; i++) {
    const stop = columns.stops[i]!;
    if (stop < 0 || stop >= stops.length) throw new CacheError("a stop time refers to a stop that isn't there");
  }
  const compiled: CompiledFeed = {
    stops,
    routes,
    calendar: header.calendar,
    trips,
    columns,
    transfers: header.transfers.map(([from, to, seconds]) => ({ from, to, seconds })),
    pathways,
    stats: header.stats,
  };
  const shapes = Shapes.fromColumns({
    ids: header.shapeIds,
    start: int32("shapeStart"),
    lat: int32("shapeLat"),
    lon: int32("shapeLon"),
    dist: float32("shapeDist"),
  });
  return { compiled, shapes };
}

function expect<T>(array: unknown, type: new (...args: never[]) => T, name: string): T {
  if (!(array instanceof type)) throw new CacheError(`${name} has the wrong type`);
  return array;
}

function align(n: number): number {
  return Math.ceil(n / 8) * 8;
}

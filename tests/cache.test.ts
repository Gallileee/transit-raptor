/**
 * The compiled feed and its binary cache: a day cut out of the cache must be exactly the day
 * read from the CSV files, and anything wrong with the cache file must mean "read the CSV".
 */
import { appendFileSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cacheFile, decode, encode, fingerprint, openFeed } from "../src/cache.js";
import { main } from "../src/cli.js";
import { compileFeed, feedForDate, loadFeed } from "../src/gtfs.js";
import { Planner } from "../src/service.js";
import { Shapes } from "../src/shapes.js";
import { parseDate } from "../src/time.js";

const MINI = join(import.meta.dirname, "fixtures", "mini");
const DATES = ["2026-11-10", "2026-11-14", "2026-11-17", "2026-11-18"].map(parseDate);

let work: string; // a copy of the test feed, so files can be changed
let cacheDir: string;
let lines: string[];
const log = (line: string) => lines.push(line);

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "transit-raptor-cache-"));
  cpSync(MINI, join(work, "feed"), { recursive: true });
  cacheDir = join(work, "cache");
  lines = [];
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const feedDir = () => join(work, "feed");
const open = () => openFeed(feedDir(), { cacheDir, log });

describe("compiled feed", () => {
  it("gives each date the same feed as reading it for that date", async () => {
    const compiled = await compileFeed(MINI);
    for (const date of DATES) expect(feedForDate(compiled, date)).toEqual(await loadFeed(MINI, date));
  });

  it("shares the stop-time arrays between dates instead of copying them", async () => {
    const compiled = await compileFeed(MINI);
    const trip = feedForDate(compiled, DATES[0]!).trips.find((t) => t.id === "L1a")!;
    expect(trip.stops.buffer).toBe(compiled.columns.stops.buffer);
    expect(feedForDate(compiled, DATES[0]!).stops).toBe(feedForDate(compiled, DATES[3]!).stops);
  });

  it("only complains about a broken trip on the days it runs", async () => {
    // EXTRA runs on 17 Nov only; give its trip a stop that doesn't exist.
    const trips = readFileSync(join(feedDir(), "trips.txt"), "utf8");
    const extra = trips.split("\n").find((l) => l.includes(",EXTRA,"))!.split(",")[2]!;
    appendFileSync(join(feedDir(), "stop_times.txt"), `${extra},09:00:00,09:00:00,NOWHERE,99,0,0,\n`);
    const compiled = await compileFeed(feedDir());
    expect(() => feedForDate(compiled, DATES[0]!)).not.toThrow();
    expect(() => feedForDate(compiled, DATES[2]!)).toThrow(/unknown stop_id "NOWHERE"/);
  });
});

describe("cache file", () => {
  it("decodes to exactly what was encoded", async () => {
    const compiled = await compileFeed(MINI);
    const shapes = await Shapes.load(MINI);
    const decoded = decode(encode(compiled, shapes, "print"), "print");
    expect(decoded.compiled).toEqual(compiled);
    expect(decoded.shapes.columns).toEqual(shapes.columns);
    expect(decoded.shapes.get("SH1")).toEqual(shapes.get("SH1"));
  });

  it("starts every array at a multiple of 8 bytes", async () => {
    const bytes = encode(await compileFeed(MINI), await Shapes.load(MINI), "print");
    const header = JSON.parse(bytes.subarray(24, 24 + bytes.readUInt32LE(12)).toString());
    expect(header.sections.length).toBe(10);
    for (const section of header.sections) expect(section.offset % 8).toBe(0);
  });

  it("works when the bytes don't start on a 4-byte boundary (copies instead of a view)", async () => {
    const bytes = encode(await compileFeed(MINI), await Shapes.load(MINI), "print");
    const shifted = Buffer.alloc(bytes.length + 1).subarray(1);
    bytes.copy(shifted);
    expect(decode(shifted, "print").compiled.columns.arrivals).toEqual(decode(bytes, "print").compiled.columns.arrivals);
  });

  it("refuses a file from another feed, format, or with damaged bytes", async () => {
    const bytes = encode(await compileFeed(MINI), await Shapes.load(MINI), "print");
    expect(() => decode(bytes, "other")).toThrow(/feed changed/);
    expect(() => decode(Buffer.from("hello, world, this is no cache"), "print")).toThrow(/not a cache file/);
    const format = Buffer.from(bytes);
    format.writeUInt32LE(99, 8);
    expect(() => decode(format, "print")).toThrow(/format 99/);
    const flipped = Buffer.from(bytes);
    flipped[bytes.length - 3]! ^= 0xff;
    expect(() => decode(flipped, "print")).toThrow(/checksum/);
    expect(() => decode(bytes.subarray(0, 30), "print")).toThrow(/cut off|checksum/);
  });
});

describe("openFeed", () => {
  it("reads the CSV files once, then the cache", async () => {
    const first = await open();
    expect(first.source).toBe("csv");
    expect(lines).toEqual([expect.stringMatching(/^cache: wrote .*feed-[0-9a-f]{16}\.bin \(\d+\.\d MB\)$/)]);
    const second = await open();
    expect(second.source).toBe("cache");
    expect(lines[1]).toMatch(/^cache: read .* in \d+ ms$/);
    for (const date of DATES) {
      expect(feedForDate(second.compiled, date)).toEqual(feedForDate(first.compiled, date));
    }
    expect(second.shapes.size).toBe(3);
  });

  it("rebuilds when a feed file changes, even only its modification time", async () => {
    await open();
    const stopTimes = join(feedDir(), "stop_times.txt");
    utimesSync(stopTimes, new Date(2030, 0, 1), new Date(2030, 0, 1));
    expect((await open()).source).toBe("csv");
    expect(lines[1]).toMatch(/^cache: not used \(the feed changed since it was written\), reading the feed$/);
    expect((await open()).source).toBe("cache"); // and the new cache is used next time
  });

  it("rebuilds when a file appears that wasn't there", async () => {
    const before = fingerprint(feedDir());
    writeFileSync(join(feedDir(), "feed_info.txt"), "ignored\n"); // not a file it reads
    expect(fingerprint(feedDir())).toBe(before);
    rmSync(join(feedDir(), "levels.txt"));
    expect(fingerprint(feedDir())).not.toBe(before);
  });

  it("reads the CSV files again when the cache is damaged, and repairs it", async () => {
    await open();
    const file = cacheFile(cacheDir, feedDir());
    const bytes = readFileSync(file);
    writeFileSync(file, bytes.subarray(0, bytes.length >> 1));
    expect((await open()).source).toBe("csv");
    expect(lines[1]).toMatch(/^cache: not used \((checksum mismatch|file is cut off)\)/);
    expect(readFileSync(file).length).toBe(bytes.length);
  });

  it("still loads when the cache can't be written", async () => {
    writeFileSync(join(work, "a-file"), "");
    const opened = await openFeed(feedDir(), { cacheDir: join(work, "a-file"), log });
    expect(opened.source).toBe("csv");
    expect(lines).toEqual([expect.stringMatching(/^cache: not written \(/)]);
  });

  it("writes nothing without a cache folder, and skips shapes when they're not wanted", async () => {
    const opened = await openFeed(feedDir(), { shapes: false });
    expect(opened.shapes.size).toBe(0);
    expect(readdirSync(work)).toEqual(["feed"]);
  });

  it("keeps a feed's cache separate from another feed's in the same folder", () => {
    expect(cacheFile(cacheDir, feedDir())).not.toBe(cacheFile(cacheDir, MINI));
  });
});

describe("Planner and command line with a cache", () => {
  it("plans the same journeys from the cache", async () => {
    const now = () => new Date(2026, 10, 10, 7, 58);
    const request = { from: "Alpha", to: "Delta", date: "2026-11-10", time: "08:00", window: 0 };
    const fresh = await new Planner(feedDir(), now, 2, log, cacheDir).plan(request);
    const cached = await new Planner(feedDir(), now, 2, log, cacheDir).plan(request);
    expect(lines.map((l) => l.split(" ")[1])).toEqual(["wrote", "read"]);
    expect(cached).toEqual(fresh);
    expect(fresh.journeys.length).toBeGreaterThan(0);
  });

  it("takes --cache DIR and refuses --cache with --no-cache", async () => {
    const err: string[] = [];
    const io = { out: () => {}, err: (l: string) => err.push(l), now: () => new Date(2026, 10, 10, 7, 58) };
    const args = ["plan", "--gtfs", feedDir(), "--from", "Alpha", "--to", "Delta", "--cache", cacheDir];
    expect(await main(args, io)).toBe(0);
    expect(await main(args, io)).toBe(0);
    expect(err.filter((l) => l.startsWith("cache:")).map((l) => l.split(" ")[1])).toEqual(["wrote", "read"]);
    expect(await main([...args, "--no-cache"], io)).toBe(2);
    expect(err.at(-2)).toBe("transit-raptor: --cache and --no-cache don't go together");
  });
});

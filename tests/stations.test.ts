/**
 * Changes inside a station from pathways.txt, on the "Gamma" station of the test feed:
 *
 *   M1 (platform, boarding areas M1A, M1B)      M2 (platform, boarding areas M2A, M2B)
 *     M1A --30 s-- N1 --escalator down 40 s--> M2A --20 s-- M2B
 *     M1B --50 s-- N1 <--escalator up 70 s---- M2A
 *                  N1 --20 stairs-- GE (entrance) -- a few metres -- S (street stop "Gamma Street")
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { distanceMetres } from "../src/geo.js";
import { loadFeed } from "../src/gtfs.js";
import { plan } from "../src/raptor.js";
import { DEFAULT_STATION, dijkstra, MinHeap, stationTransfers } from "../src/stations.js";
import { StopIndex } from "../src/stops.js";
import { parseClock, parseDate } from "../src/time.js";
import { buildTimetable, DEFAULT_WALK } from "../src/timetable.js";

const MINI = join(import.meta.dirname, "fixtures", "mini");
const BUFFER = DEFAULT_STATION.bufferSeconds;

async function setup() {
  const feed = await loadFeed(MINI, parseDate("2026-11-10"));
  const id = (s: string) => feed.stopById.get(s)!;
  const transfers = stationTransfers(feed, DEFAULT_WALK);
  const change = (from: string, to: string) => transfers.find((t) => t.from === id(from) && t.to === id(to))?.seconds;
  const gate = feed.stops[id("GE")]!;
  const street = feed.stops[id("S")]!;
  const surface = (distanceMetres(gate.lat, gate.lon, street.lat, street.lon) * DEFAULT_WALK.detour) / DEFAULT_WALK.speed;
  return { feed, id, change, surface };
}

describe("MinHeap", () => {
  it("pops in key order", () => {
    const heap = new MinHeap();
    for (const [k, v] of [[5, 50], [1, 10], [4, 40], [1, 11], [3, 30], [2, 20]] as const) heap.push(k, v);
    const keys: number[] = [];
    for (let top = heap.pop(); top !== undefined; top = heap.pop()) keys.push(top[0]);
    expect(keys).toEqual([1, 1, 2, 3, 4, 5]);
    expect(heap.size).toBe(0);
  });
});

describe("pathways", () => {
  it("loads pathways, skipping ones that name an unknown stop", async () => {
    const { feed } = await setup();
    expect(feed.pathways).toHaveLength(9);
    const stairs = feed.pathways.find((p) => p.mode === 2)!;
    expect([stairs.stairs, stairs.seconds, stairs.bidirectional]).toEqual([20, undefined, true]);
  });

  it("follows one-way escalators", async () => {
    const { feed, id } = await setup();
    const graph = feed.stops.map(() => [] as { to: number; seconds: number }[]);
    for (const p of feed.pathways) {
      graph[p.from]!.push({ to: p.to, seconds: p.seconds ?? 0 });
      if (p.bidirectional) graph[p.to]!.push({ to: p.from, seconds: p.seconds ?? 0 });
    }
    const fromM1A = dijkstra(graph, id("M1A"));
    expect(fromM1A.get(id("M2A"))).toBe(70); // 30 walk + 40 escalator down
    expect(fromM1A.get(id("M2B"))).toBe(90);
    expect(dijkstra(graph, id("M2A")).get(id("M1A"))).toBe(100); // 70 up + 30 walk
  });
});

describe("station changes", () => {
  it("platform to platform: average over where one gets off, nearest where one gets on", async () => {
    const { change } = await setup();
    // From M1A 70 s and from M1B 90 s to the nearest boarding area of M2: average 80.
    expect(change("M1", "M2")).toBe(80 + BUFFER);
    // Back up: from M2A 100 s, from M2B 120 s (the up escalator is slower).
    expect(change("M2", "M1")).toBe(110 + BUFFER);
  });

  it("platform to street and back, through the entrance", async () => {
    const { change, surface } = await setup();
    const stairs = 20 * DEFAULT_STATION.secondsPerStair; // N1 and GE share coordinates
    expect(change("M1", "S")).toBe(Math.ceil((30 + 50) / 2 + stairs + surface + BUFFER));
    expect(change("M2", "S")).toBe(Math.ceil((70 + (20 + 70)) / 2 + stairs + surface + BUFFER));
    expect(change("S", "M1")).toBe(Math.ceil(surface + stairs + 30 + BUFFER)); // nearest area: M1A
    expect(change("S", "M2")).toBe(Math.ceil(surface + stairs + 40 + BUFFER)); // down to M2A
  });

  it("replaces the distance-and-levels estimate in the timetable", async () => {
    const { feed, id } = await setup();
    const timetable = buildTimetable(feed);
    const walk = (from: string, to: string) => timetable.footpaths[id(from)]!.find((f) => f.to === id(to))?.seconds;
    expect(walk("M1", "M2")).toBe(80 + BUFFER);
    // Without pathways it would be distance plus two levels: much longer.
    const stop = (s: string) => feed.stops[id(s)]!;
    const estimate =
      Math.ceil((distanceMetres(stop("M1").lat, stop("M1").lon, stop("M2").lat, stop("M2").lon) * 1.3) / 1.2) + 2 * 45;
    expect(estimate).toBeGreaterThan(80 + BUFFER + 30);
  });

  it("makes a connection that the estimate would miss", async () => {
    const { feed } = await setup();
    const timetable = buildTimetable(feed);
    const index = new StopIndex(feed.stops);
    const stops = (name: string) => (index.find(name) as { stops: number[] }).stops;
    // Line 11 reaches Gamma (M1) at 09:10:00; line 12 leaves M2 at 09:12:30. The change takes
    // 125 s through the station (arrive 09:12:05), but ~185 s by the estimate (09:13:05).
    const [journey] = plan(timetable, { from: stops("Alpha"), to: stops("Echo"), departAt: parseClock("08:55"), maxTransfers: 2 });
    expect(journey!.arrival).toBe(parseClock("09:20"));
    expect(journey!.legs.map((l) => l.kind)).toEqual(["ride", "walk", "ride"]);
  });

  it("does nothing for a feed without pathways", async () => {
    const { feed } = await setup();
    expect(stationTransfers({ ...feed, pathways: [] }, DEFAULT_WALK)).toEqual([]);
  });
});

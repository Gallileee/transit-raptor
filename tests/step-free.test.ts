/**
 * Step-free journeys (wheelchairs, prams), on the test feed:
 *
 * - Trips: tram 1 (L1a, L1b) can't take a wheelchair, the 300 express (L3express) can; the
 *   others say nothing (unknown, allowed).
 * - Stops: Alpha and Charlie are step-free; Foxtrot North is not; the Bravo station is not, and
 *   its platforms B1 and B2 say nothing, so they inherit "not" from it.
 * - Gamma: besides the stairs and escalators of stations.test.ts, three elevators to the street:
 *
 *     M1A --elevator 120 s-- GE2 (north exit, marked not step-free)
 *     M1B --elevator 120 s-- GE4 (west lift)  ~127 m along the street to  GE3 (east lift)
 *     M2B --elevator 120 s-- GE3
 *
 *   Without stairs and escalators, the only way from M1 to M2 is up at GE4, along the street,
 *   and down at GE3. GE2 is closer to GE3, but marked as not step-free.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { distanceMetres } from "../src/geo.js";
import { loadFeed } from "../src/gtfs.js";
import { plan } from "../src/raptor.js";
import { combinedAccess, Planner } from "../src/service.js";
import { DEFAULT_STATION, isStepFree, stationTransfers } from "../src/stations.js";
import { StopIndex } from "../src/stops.js";
import { parseClock, parseDate } from "../src/time.js";
import { buildTimetable, DEFAULT_WALK } from "../src/timetable.js";

const MINI = join(import.meta.dirname, "fixtures", "mini");
const BUFFER = DEFAULT_STATION.bufferSeconds;

async function setup() {
  const feed = await loadFeed(MINI, parseDate("2026-11-10"));
  const id = (s: string) => feed.stopById.get(s)!;
  const index = new StopIndex(feed.stops);
  const stops = (name: string) => (index.find(name) as { stops: number[] }).stops;
  const street = (a: string, b: string) => {
    const x = feed.stops[id(a)]!;
    const y = feed.stops[id(b)]!;
    return (distanceMetres(x.lat, x.lon, y.lat, y.lon) * DEFAULT_WALK.detour) / DEFAULT_WALK.speed;
  };
  return { feed, id, stops, street };
}

describe("accessibility in the feed", () => {
  it("reads wheelchair_boarding, and platforms without a value inherit the station's", async () => {
    const { feed, id } = await setup();
    const access = (s: string) => feed.stops[id(s)]!.wheelchair;
    expect([access("A"), access("F1"), access("D")]).toEqual([1, 2, 0]);
    expect([access("P"), access("B1"), access("B2")]).toEqual([2, 2, 2]); // inherited
    expect([access("GE3"), access("GE2")]).toEqual([1, 2]); // an entrance inherits too, unless it says otherwise
    expect(access("S")).toBe(0); // a stop without a parent keeps "unknown"
  });

  it("reads wheelchair_accessible of trips", async () => {
    const { feed } = await setup();
    const trip = (t: string) => feed.trips.find((x) => x.id === t)!.wheelchair;
    expect([trip("L1a"), trip("L3express"), trip("L3slow")]).toEqual([2, 1, 0]);
  });

  it("combines a leg's parts: any no is no, all yes is yes", () => {
    expect(combinedAccess([1, 1, 1])).toBe("yes");
    expect(combinedAccess([1, 0, 1])).toBe("unknown");
    expect(combinedAccess([1, 2, 0])).toBe("no");
  });

  it("knows which pathways a wheelchair can use", () => {
    const modes = [1, 2, 3, 4, 5, 6, 7].filter((mode) => isStepFree({ from: 0, to: 0, mode, bidirectional: true, seconds: 1, stairs: 0 }));
    expect(modes).toEqual([1, 3, 5, 6, 7]); // not stairs (2) or escalators (4)
  });
});

describe("step-free changes inside stations", () => {
  it("avoids stairs and escalators, and leaves through step-free entrances only", async () => {
    const { feed, id, street } = await setup();
    const change = (stepFree: boolean, from: string, to: string) =>
      stationTransfers(feed, DEFAULT_WALK, DEFAULT_STATION, stepFree).find((t) => t.from === id(from) && t.to === id(to))
        ?.seconds;
    expect(change(false, "M1", "M2")).toBe(80 + BUFFER); // the escalator, as before
    // From M1A: 30 + 50 to M1B, then the west lift (120), the street, the east lift (120) to M2B.
    // From M1B: straight into the west lift. Average over the two.
    const outside = street("GE4", "GE3");
    expect(change(true, "M1", "M2")).toBe(Math.ceil((30 + 50 + 120 + 120 + (120 + 120)) / 2 + outside + BUFFER));
    // Back: from M2B into the east lift, from M2A 20 s more; then the street and the west lift
    // to M1B, the nearest boarding area of M1.
    expect(change(true, "M2", "M1")).toBe(Math.ceil((20 + 120 + 120 + (120 + 120)) / 2 + outside + BUFFER));
  });

  it("goes out to the street by a lift, not by the exit marked as not step-free", async () => {
    const { feed, id, street } = await setup();
    const change = (from: string, to: string) =>
      stationTransfers(feed, DEFAULT_WALK, DEFAULT_STATION, true).find((t) => t.from === id(from) && t.to === id(to))?.seconds;
    // From M1A to the west lift is 30 + 50 + 120 s, from M1B 120 s; then the street to S. The
    // north exit GE2 would be 120 s from M1A and nearer to S, but it is marked as not step-free.
    expect(change("M1", "S")).toBe(Math.ceil((30 + 50 + 120 + 120) / 2 + street("GE4", "S") + BUFFER));
    expect(change("S", "M1")).toBe(Math.ceil(street("S", "GE4") + 120 + BUFFER));
  });

  it("drops the distance estimate where only stairs or escalators connect two stops", async () => {
    const { feed, id } = await setup();
    const withoutElevators = { ...feed, pathways: feed.pathways.filter((p) => p.mode !== 5) };
    const walk = (stepFree: boolean, from: string, to: string) =>
      buildTimetable(withoutElevators, { stepFree }).footpaths[id(from)]!.find((f) => f.to === id(to))?.seconds;
    expect(walk(false, "M1", "M2")).toBe(80 + BUFFER);
    expect(walk(false, "M1", "S")).toBeDefined();
    // 86 m apart, so the estimate from distance alone would offer a change; the station says no.
    expect(walk(true, "M1", "M2")).toBeUndefined();
    expect(walk(true, "M1", "S")).toBeUndefined();
    expect(walk(true, "S", "M2")).toBeUndefined();
  });

  it("can't walk to or from a stop that has no step-free access", async () => {
    const { feed, id } = await setup();
    const normal = buildTimetable(feed);
    const stepFree = buildTimetable(feed, { stepFree: true });
    expect(normal.footpaths[id("B1")]!.map((f) => f.to)).toContain(id("B2"));
    expect(stepFree.footpaths[id("B1")]).toEqual([]);
    expect(stepFree.footpaths[id("G")]!.map((f) => f.to)).not.toContain(id("B2"));
  });
});

describe("step-free journeys", () => {
  it("skips vehicles that can't take a wheelchair", async () => {
    const { feed, stops } = await setup();
    const query = { from: stops("Alpha"), to: stops("Charlie"), departAt: parseClock("08:00"), maxTransfers: 2 };
    const lines = (stepFree: boolean) =>
      plan(buildTimetable(feed, { stepFree }), query).map((j) =>
        j.legs.map((l) => (l.kind === "ride" ? `${feed.routes.get(l.routeId)!.shortName} ${l.departure / 60}` : "walk")),
      );
    expect(lines(false)[0]).toEqual(["1 480"]); // tram 1 at 08:00
    expect(lines(true)).toEqual([["300 485"]]); // the express at 08:05, arriving 08:18
  });

  it("doesn't get on or off where the stop has no step-free access", async () => {
    const { feed, stops } = await setup();
    const query = { from: stops("Charlie"), to: stops("Foxtrot North"), departAt: parseClock("08:15"), maxTransfers: 2 };
    expect(plan(buildTimetable(feed), query)).not.toEqual([]);
    expect(plan(buildTimetable(feed, { stepFree: true }), query)).toEqual([]);
  });

  it("takes a later connection when the step-free change is longer", async () => {
    const { feed, stops } = await setup();
    const query = { from: stops("Alpha"), to: stops("Echo"), departAt: parseClock("08:55"), maxTransfers: 2 };
    const [normal] = plan(buildTimetable(feed), query);
    const [stepFree] = plan(buildTimetable(feed, { stepFree: true }), query);
    // Line 11 reaches M1 at 09:10. Via the escalator line 12 at 09:12:30 is in reach; via the lifts
    // and the street (~7.7 min) only the 09:20 one.
    expect(normal!.arrival).toBe(parseClock("09:20"));
    expect(stepFree!.arrival).toBe(parseClock("09:28"));
    expect(stepFree!.legs.map((l) => l.kind)).toEqual(["ride", "walk", "ride"]);
  });
});

describe("step-free in the API and the CLI", () => {
  const planner = new Planner(MINI, () => new Date(2026, 10, 10, 7, 58));

  it("plans step-free on request and says how sure the feed is about each ride", async () => {
    const request = { from: "alpha", to: "charlie", date: "2026-11-10", time: "08:00", window: 0 };
    const normal = await planner.plan(request);
    expect(normal.stepFree).toBe(false);
    const tram = normal.journeys[0]!.legs[0]!;
    expect(tram).toMatchObject({ kind: "ride", line: "1", access: "no" });

    const stepFree = await planner.plan({ ...request, stepFree: true });
    expect(stepFree.stepFree).toBe(true);
    expect(stepFree.journeys.map((j) => j.legs.map((l) => (l.kind === "ride" ? [l.line, l.access] : l.kind)))).toEqual([
      [["300", "yes"]], // vehicle, Alpha and Charlie all marked step-free
    ]);
  });

  it("builds the step-free timetable once per date, and only when asked", async () => {
    const loaded = await planner.load({ year: 2026, month: 11, day: 10 });
    const first = loaded.stepFreeTimetable();
    expect(first.stepFree).toBe(true);
    expect(loaded.stepFreeTimetable()).toBe(first);
    expect(loaded.timetable.stepFree).toBe(false);
  });

  it("has --step-free in the CLI", async () => {
    const out: string[] = [];
    const io = { out: (l: string) => out.push(l), err: () => {}, now: () => new Date(2026, 10, 10, 8, 15) };
    const args = ["plan", "--gtfs", MINI, "--from", "charlie", "--to", "foxtrot north", "--window", "0"];
    expect(await main(args, io)).toBe(0);
    out.length = 0;
    expect(await main([...args, "--step-free"], io)).toBe(1);
    expect(out).toEqual(["No step-free journey from Charlie to Foxtrot North with at most 4 transfers."]);
  });
});

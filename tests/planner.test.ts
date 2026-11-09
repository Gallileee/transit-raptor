/**
 * The planner on a small hand-made feed (tests/fixtures/mini). Each scenario there exists to
 * test one thing; the comments say which.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activeServices, loadFeed } from "../src/gtfs.js";
import { formatLeg } from "../src/format.js";
import { plan, withoutDetours, type Journey } from "../src/raptor.js";
import { normalize, StopIndex } from "../src/stops.js";
import { parseClock, parseDate } from "../src/time.js";
import { buildTimetable, distanceMetres } from "../src/timetable.js";

const MINI = join(import.meta.dirname, "fixtures", "mini");
const TUESDAY = "2026-11-10";

async function setup(date = TUESDAY) {
  const feed = await loadFeed(MINI, parseDate(date));
  const timetable = buildTimetable(feed);
  const index = new StopIndex(feed.stops);
  const stops = (name: string) => {
    const match = index.find(name);
    if (match.kind !== "found") throw new Error(`no stop ${name}`);
    return match.stops;
  };
  const query = (from: string, to: string, time: string, maxTransfers = 4) =>
    plan(timetable, { from: stops(from), to: stops(to), departAt: parseClock(time), maxTransfers });
  return { feed, timetable, query };
}

/** A journey as text that's easy to compare: "08:05 1 B1->C 08:10". */
function describeJourney(feed: Awaited<ReturnType<typeof setup>>["feed"], journey: Journey): string[] {
  const clock = (t: number) => `${String(Math.floor(t / 3600)).padStart(2, "0")}:${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}`;
  return journey.legs.map((leg) => {
    const from = feed.stops[leg.from]!.id;
    const to = feed.stops[leg.to]!.id;
    const what = leg.kind === "walk" ? "walk" : feed.routes.get(leg.routeId)!.shortName;
    return `${clock(leg.departure)} ${what} ${from}->${to} ${clock(leg.arrival)}`;
  });
}

describe("loading", () => {
  it("keeps only the trips that run on the date", async () => {
    const { feed } = await setup();
    // WK runs on a Tuesday; EXTRA only on 17 Nov. L5night runs today and (from Monday) after midnight.
    expect(feed.trips.map((t) => t.id).sort()).toEqual(
      ["L10a", "L1a", "L1b", "L2a", "L2b", "L3express", "L3slow", "L11a", "L12a", "L5night", "L5night@prev", "L8a", "L9a"].sort(),
    );
    expect(feed.stats.stopTimesRead).toBe(33);
  });

  it("applies calendar_dates: a removed day and an added service", async () => {
    const holiday = await activeServices(MINI, parseDate("2026-11-17"));
    expect([...holiday]).toEqual(["EXTRA"]);
    const saturday = await activeServices(MINI, parseDate("2026-11-14"));
    expect(saturday.size).toBe(0);
  });

  it("sorts stop_times by stop_sequence and fills stops without times", async () => {
    const { feed } = await setup();
    const express = feed.trips.find((t) => t.id === "L3express")!;
    expect([...express.stops].map((s) => feed.stops[s]!.id)).toEqual(["A", "C", "D"]);
    const l9 = feed.trips.find((t) => t.id === "L9a")!;
    // B2 has no times: it takes the previous stop's departure, 08:20.
    expect(l9.arrivals[1]).toBe(parseClock("08:20"));
    expect(l9.departures[1]).toBe(parseClock("08:20"));
  });

  it("reads quoted names with commas and diacritics", async () => {
    const { feed } = await setup();
    expect(feed.stops.find((s) => s.id === "D")!.name).toBe("Delta, Náměstí");
  });
});

describe("timetable", () => {
  it("puts an overtaking express into a pattern of its own", async () => {
    const { timetable } = await setup();
    const l3 = timetable.patterns.filter((p) => p.routeId === "L3");
    expect(l3.map((p) => p.trips.map((t) => t.id))).toEqual([["L3slow"], ["L3express"]]);
  });

  it("builds footpaths from distance and from transfers.txt", async () => {
    const { feed, timetable } = await setup();
    const id = (s: string) => feed.stopById.get(s)!;
    const walk = (from: string, to: string) => timetable.footpaths[id(from)]!.find((f) => f.to === id(to))?.seconds;
    expect(walk("B1", "B2")).toBe(79); // 72.4 m x 1.3 detour / 1.2 m/s = 78.4 s, rounded up
    expect(walk("G", "B2")).toBe(60); // ~37 m: the 60 s minimum
    expect(walk("F1", "F2")).toBe(240); // 556 m is too far to walk by distance; transfers.txt allows it
    expect(walk("A", "B1")).toBeUndefined(); // 1.1 km
    expect(timetable.footpaths[id("P")]).toEqual([]); // a station (location_type 1) isn't a stop
    expect(Math.round(distanceMetres(50, 14, 50.01, 14))).toBe(1113);
  });
});

describe("plan", () => {
  it("returns the Pareto set: direct, or faster with a transfer and a walk", async () => {
    const { feed, query } = await setup();
    const journeys = query("Alpha", "Delta, Náměstí", "08:00");
    expect(journeys.map((j) => [j.transfers, describeJourney(feed, j)])).toEqual([
      [0, ["08:05 300 A->D 08:30"]],
      [1, ["08:00 1 A->B1 08:05", "08:05 walk B1->B2 08:06", "08:08 200 B2->D 08:15"]],
    ]);
  });

  it("respects the transfer limit", async () => {
    const { query } = await setup();
    const journeys = query("Alpha", "Delta, Náměstí", "08:00", 0);
    expect(journeys.map((j) => j.transfers)).toEqual([0]);
  });

  it("finds the express that overtakes an earlier departure", async () => {
    const { query } = await setup();
    // At 07:59 the first L3 bus to leave is the slow 08:00 one (arr 08:40); the 08:05
    // express arrives 08:30. Without splitting patterns, RAPTOR would only see the slow one.
    const [direct] = query("Alpha", "Delta, Náměstí", "07:59", 0);
    expect(direct!.arrival).toBe(parseClock("08:30"));
  });

  it("does not board where pickup isn't allowed", async () => {
    const { feed, query } = await setup();
    // Line 8 leaves Bravo 1 at 08:01 and reaches Charlie at 08:03, but it doesn't pick up there.
    const [journey] = query("Bravo", "Charlie", "08:00");
    expect(describeJourney(feed, journey!)).toEqual(["08:05 1 B1->C 08:10"]);
  });

  it("walks from a stop without service and leaves just in time", async () => {
    const { feed, query } = await setup();
    const [journey] = query("Bravo Gate", "Delta", "08:00");
    expect(describeJourney(feed, journey!)).toEqual(["08:07 walk G->B2 08:08", "08:08 200 B2->D 08:15"]);
    expect(journey!.departure).toBe(parseClock("08:07"));
  });

  it("uses transfers.txt for a walk longer than the distance limit", async () => {
    const { feed, query } = await setup();
    const [journey] = query("Charlie", "Echo", "08:15");
    expect(describeJourney(feed, journey!)).toEqual([
      "08:20 9 C->F1 08:25",
      "08:25 walk F1->F2 08:29",
      "08:30 10 F2->E 08:40",
    ]);
    expect(journey!.transfers).toBe(1);
  });

  it("catches yesterday's night bus after midnight", async () => {
    const { query } = await setup("2026-11-11"); // a Wednesday: Tuesday's 24:10 bus is Wednesday 00:10
    const [journey] = query("Charlie", "Delta", "00:05");
    expect([journey!.departure, journey!.arrival]).toEqual([parseClock("00:10"), parseClock("00:30")]);
  });

  it("but not on a Monday, when Sunday has no service", async () => {
    const { feed, query } = await setup("2026-11-09");
    expect(feed.trips.some((t) => t.id.endsWith("@prev"))).toBe(false);
    // So at 00:05 the next bus from Charlie is the morning express (08:18 -> 08:30).
    const [journey] = query("Charlie", "Delta", "00:05");
    expect([journey!.departure, journey!.arrival]).toEqual([parseClock("08:18"), parseClock("08:30")]);
  });

  it("shows a night bus after midnight as the next day", async () => {
    const { query } = await setup();
    const [journey] = query("Alpha", "Delta", "23:00");
    // Tuesday's 23:55 bus arrives at 24:30, i.e. 00:30 on Wednesday.
    expect([journey!.departure, journey!.arrival]).toEqual([parseClock("23:55"), parseClock("24:30")]);
  });

  it("uses the holiday timetable from calendar_dates", async () => {
    const { query } = await setup("2026-11-17");
    const journeys = query("Alpha", "Delta", "08:00");
    expect(journeys.map((j) => [j.departure, j.arrival])).toEqual([[parseClock("09:00"), parseClock("09:40")]]);
  });

  it("returns nothing when nothing runs, or when start and end are the same", async () => {
    expect((await setup("2026-11-14")).query("Alpha", "Delta", "08:00")).toEqual([]);
    expect((await setup()).query("Alpha", "Alpha", "08:00")).toEqual([]);
  });
});

describe("stop names", () => {
  it("normalizes case, diacritics and punctuation", () => {
    expect(normalize("  Delta,  Náměstí ")).toBe("delta namesti");
  });

  it("finds exact names, unique prefixes, and explains the rest", async () => {
    const { feed } = await setup();
    const index = new StopIndex(feed.stops);
    expect(index.find("delta namesti")).toMatchObject({ kind: "found", name: "Delta, Náměstí" });
    expect(index.find("BRAVO")).toMatchObject({ kind: "found", stops: [1, 2] }); // B1, B2; not the station P
    expect(index.find("cha")).toMatchObject({ kind: "found", name: "Charlie" });
    expect(index.find("bra")).toEqual({ kind: "ambiguous", names: ["Bravo", "Bravo Gate"] });
    expect(index.find("trot")).toEqual({ kind: "none", suggestions: ["Foxtrot North", "Foxtrot South"] });
    expect(index.find("zulu")).toEqual({ kind: "none", suggestions: [] });
  });
});

describe("real-data fixes", () => {
  it("adds time for every level between two stops (escalators)", async () => {
    const { feed, timetable } = await setup();
    const id = (s: string) => feed.stopById.get(s)!;
    const stop = (s: string) => feed.stops[id(s)]!;
    const walk = (from: string, to: string) => timetable.footpaths[id(from)]!.find((f) => f.to === id(to))?.seconds;
    const flat = (a: string, b: string) =>
      Math.max(60, Math.ceil((distanceMetres(stop(a).lat, stop(a).lon, stop(b).lat, stop(b).lon) * 1.3) / 1.2));
    expect([stop("K1").level, stop("K2").level, stop("KS").level]).toEqual([-2, -4, undefined]);
    expect(walk("K1", "K2")).toBe(flat("K1", "K2") + 2 * 45); // two levels apart
    expect(walk("KS", "K1")).toBe(flat("KS", "K1") + 2 * 45); // no level = street level
    expect(walk("K2", "K1")).toBe(walk("K1", "K2"));
  });

  it("drops a direct journey that arrives hours after one with a change", async () => {
    const { feed, query } = await setup();
    // At 08:06 the only direct bus is the night bus at 23:55 (arr 24:30); with one change one
    // arrives at 08:25. The night bus is Pareto-optimal (fewer changes) but useless.
    const journeys = query("Alpha", "Delta", "08:06");
    expect(journeys.map((j) => describeJourney(feed, j))).toEqual([
      ["08:10 1 A->B1 08:15", "08:15 walk B1->B2 08:16", "08:18 200 B2->D 08:25"],
    ]);
  });

  it("keeps slower journeys within max(30 min, the fastest travel time)", () => {
    const j = (arrival: number, transfers: number) => ({ legs: [], departure: 0, arrival, transfers });
    const at = (h: number, m = 0) => h * 3600 + m * 60;
    // Fastest: 08:20 after leaving at 08:00 (20 min) -> slack 30 min -> up to 08:50.
    expect(withoutDetours([j(at(8, 50), 0), j(at(8, 51), 0), j(at(8, 20), 1)], at(8)).map((x) => x.arrival)).toEqual([
      at(8, 50),
      at(8, 20),
    ]);
    // Fastest: 10:00 after 08:00 (2 h) -> slack 2 h -> up to 12:00.
    expect(withoutDetours([j(at(12), 0), j(at(10), 2)], at(8)).length).toBe(2);
    expect(withoutDetours([], at(8))).toEqual([]);
  });

  it("calls a walk between unnamed platforms of one stop a change", async () => {
    const { feed } = await setup();
    const id = (s: string) => feed.stopById.get(s)!;
    const leg = { kind: "walk" as const, from: id("M1"), to: id("M2"), departure: 28800, arrival: 29000 };
    expect(formatLeg(feed, leg)).toBe("  08:00–08:03  walk 3 min: change platforms at Gamma");
    expect(formatLeg(feed, { ...leg, from: id("B1"), to: id("B2") })).toBe("  08:00–08:03  walk 3 min: Bravo (1) -> Bravo (2)");
  });
});

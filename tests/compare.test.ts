/**
 * The journey comparison behind `npm run compare-journeys` (src/compare.ts).
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareJourneys,
  compareResults,
  formatReport,
  journeyKey,
  journeyProblems,
  planQueries,
  sampleQueries,
  type Side,
} from "../src/compare.js";
import { loadFeed } from "../src/gtfs.js";
import { type Journey, type Leg, plan } from "../src/raptor.js";
import { StopIndex } from "../src/stops.js";
import { parseClock, parseDate } from "../src/time.js";
import { buildTimetable } from "../src/timetable.js";

const MINI = join(import.meta.dirname, "fixtures", "mini");
const at = parseClock;

const ride = (from: number, to: number, departure: string, arrival: string, routeId = "R"): Leg => ({
  kind: "ride",
  routeId,
  tripId: `${routeId}-1`,
  headsign: "",
  from,
  to,
  departure: at(departure),
  arrival: at(arrival),
  stopCount: 1,
});
const walk = (from: number, to: number, departure: string, arrival: string): Leg => ({
  kind: "walk",
  from,
  to,
  departure: at(departure),
  arrival: at(arrival),
});
const journey = (...legs: Leg[]): Journey => ({
  legs,
  departure: legs[0]!.departure,
  arrival: legs.at(-1)!.arrival,
  transfers: Math.max(0, legs.filter((l) => l.kind === "ride").length - 1),
});

describe("sampleQueries", () => {
  const names = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"];

  it("gives the same queries for the same names, count and seed, and others for another seed", () => {
    const a = sampleQueries(names, 50, 7);
    expect(sampleQueries([...names].reverse(), 50, 7)).toEqual(a);
    expect(sampleQueries(names, 50, 8)).not.toEqual(a);
  });

  it("gives exactly count queries between two different stops, leaving 06:00-21:59 on the minute", () => {
    const queries = sampleQueries(names, 200, 1);
    expect(queries).toHaveLength(200);
    for (const q of queries) {
      expect(q.from).not.toBe(q.to);
      expect(q.departAt).toBeGreaterThanOrEqual(at("06:00"));
      expect(q.departAt).toBeLessThanOrEqual(at("21:59"));
      expect(q.departAt % 60).toBe(0);
    }
    expect(new Set(queries.map((q) => q.from)).size).toBe(names.length); // all names come up
  });

  it("gives nothing with fewer than two names", () => {
    expect(sampleQueries(["Alpha", "Alpha"], 5, 1)).toEqual([]);
  });
});

describe("journeyProblems", () => {
  it("finds nothing wrong with a journey that makes sense", () => {
    const fine = journey(walk(0, 1, "08:00", "08:03"), ride(1, 2, "08:05", "08:15"), walk(2, 3, "08:15", "08:17"), ride(3, 4, "08:20", "08:30"));
    expect(journeyProblems(fine, at("08:00"))).toEqual([]);
  });

  it("finds two walks in a row", () => {
    const chained = journey(ride(0, 1, "08:00", "08:10"), walk(1, 2, "08:10", "08:12"), walk(2, 3, "08:12", "08:15"));
    expect(journeyProblems(chained, at("08:00"))).toEqual(["legs 2 and 3 are two walks in a row"]);
  });

  it("finds time going backwards, legs that don't meet, and a start before the query time", () => {
    const broken = journey(ride(0, 1, "08:00", "08:10"), walk(1, 2, "08:05", "08:09"), ride(3, 4, "08:20", "08:15"));
    expect(journeyProblems(broken, at("08:01"))).toEqual([
      "leaves before the query time",
      "leg 2 leaves before leg 1 arrives",
      "leg 3 arrives before it leaves",
      "leg 3 doesn't start where leg 2 ends",
    ]);
    expect(journeyProblems({ ...journey(ride(0, 1, "08:00", "08:10")), transfers: 1 }, at("08:00"))).toEqual([
      "the number of changes doesn't match the rides",
    ]);
  });
});

describe("compareJourneys", () => {
  const ids = ["A", "B", "C", "D"];
  /** A side that knows `names` and answers every query with `journeys`. */
  const side = (journeys: Journey[], names = ["Alpha", "Delta"]): Side => ({
    resolve: (name) => (names.includes(name) ? [names.indexOf(name)] : undefined),
    plan: () => journeys,
    stopId: (i) => ids[i]!,
  });
  const query = { from: "Alpha", to: "Delta", departAt: at("08:00") };
  const direct = journey(ride(0, 3, "08:05", "08:30"));
  const viaB = journey(ride(0, 1, "08:00", "08:10"), ride(1, 3, "08:12", "08:20"));

  it("counts identical answers, by stop ids rather than indices", () => {
    const shuffled: Side = { resolve: () => [9], plan: () => [journey(ride(5, 6, "08:05", "08:30"))], stopId: (i) => (i === 5 ? "A" : "D") };
    const report = compareJourneys([query, query], side([direct]), shuffled);
    expect(report).toMatchObject({ compared: 2, skipped: 0, same: 2, differences: [], problems: [] });
  });

  it("lists differences with each side's earliest arrival", () => {
    const report = compareJourneys([query], side([direct]), side([direct, viaB]));
    expect(report.same).toBe(0);
    expect(report.differences).toEqual([
      {
        query,
        base: [journeyKey(direct, (i) => ids[i]!)],
        head: [journeyKey(direct, (i) => ids[i]!), journeyKey(viaB, (i) => ids[i]!)],
        baseArrival: at("08:30"),
        headArrival: at("08:20"),
      },
    ]);
  });

  it("skips a query a side can't resolve, and checks only the new side's journeys", () => {
    const chained = journey(ride(0, 1, "08:00", "08:10"), walk(1, 2, "08:10", "08:12"), walk(2, 3, "08:12", "08:15"));
    const report = compareJourneys([query, { ...query, to: "Bravo" }], side([chained]), side([direct]));
    expect(report).toMatchObject({ compared: 1, skipped: 1, problems: [] });
    // Either side: here only the old one knows Bravo.
    const onlyBase = compareJourneys([{ ...query, to: "Bravo" }], side([direct], ["Alpha", "Delta", "Bravo"]), side([direct]));
    expect(onlyBase).toMatchObject({ compared: 0, skipped: 1, same: 0 });
    expect(compareJourneys([query], side([direct]), side([chained])).problems).toEqual([
      { query, journey: journeyKey(chained, (i) => ids[i]!), problems: ["legs 2 and 3 are two walks in a row"] },
    ]);
  });

  it("says it in a report", () => {
    const report = compareJourneys([query, query], side([direct]), side([viaB]));
    const lines = formatReport(report, 1);
    expect(lines.slice(0, 3)).toEqual([
      "2 queries compared (0 skipped: a stop name only one version knows)",
      "0 identical, 2 different: 2 arrive earlier, 0 later, 0 at the same time another way",
      "0 journeys with problems",
    ]);
    expect(lines.slice(3)).toEqual([
      "",
      "Alpha -> Delta at 08:00",
      `  - ${journeyKey(direct, (i) => ids[i]!)}`,
      `  + ${journeyKey(viaB, (i) => ids[i]!)}`,
    ]);
  });
});

describe("on the test feed", () => {
  it("finds the same build identical to itself, with no problems", async () => {
    const feed = await loadFeed(MINI, parseDate("2026-11-10"));
    const index = new StopIndex(feed.stops);
    const timetable = buildTimetable(feed);
    const real: Side = {
      resolve: (name) => {
        const match = index.find(name);
        return match.kind === "found" ? match.stops : undefined;
      },
      plan: (query) => plan(timetable, query),
      stopId: (i) => feed.stops[i]!.id,
    };
    const names = feed.trips.flatMap((t) => [...t.stops].map((s) => feed.stops[s]!.name));
    const report = compareJourneys(sampleQueries(names, 100, 3), real, real);
    expect(report).toMatchObject({ compared: 100, skipped: 0, same: 100, differences: [], problems: [] });
  });

  it("compares answers planned apart (in worker threads) as it compares the sides", async () => {
    const feed = await loadFeed(MINI, parseDate("2026-11-10"));
    const index = new StopIndex(feed.stops);
    const sideOn = (timetable: ReturnType<typeof buildTimetable>): Side => ({
      resolve: (name) => {
        const match = index.find(name);
        return match.kind === "found" ? match.stops : undefined;
      },
      plan: (query) => plan(timetable, query),
      stopId: (i) => feed.stops[i]!.id,
    });
    const normal = sideOn(buildTimetable(feed));
    const stepFree = sideOn(buildTimetable(feed, { stepFree: true }));
    const names = [...feed.trips.flatMap((t) => [...t.stops].map((s) => feed.stops[s]!.name)), "Nowhere"];
    const queries = sampleQueries(names, 200, 5);
    const together = compareJourneys(queries, normal, stepFree);
    // As a worker sends them: structured clones (Infinity arrivals and all).
    const apart = compareResults(queries, structuredClone(planQueries(queries, normal)), structuredClone(planQueries(queries, stepFree)));
    expect(apart).toEqual(together);
    expect(together.differences.length).toBeGreaterThan(0);
    expect(together.skipped).toBeGreaterThan(0);
    expect(together.differences.some((d) => d.headArrival === Infinity)).toBe(true);
  });
});

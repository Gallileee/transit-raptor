/**
 * rRAPTOR: journeys over a window of departure times, on the test feed (Tuesday 10 Nov 2026).
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { loadFeed } from "../src/gtfs.js";
import { departureTimes, type Journey, plan, profile } from "../src/raptor.js";
import { StopIndex } from "../src/stops.js";
import { formatClock, parseClock, parseDate } from "../src/time.js";
import { buildTimetable } from "../src/timetable.js";

const MINI = join(import.meta.dirname, "fixtures", "mini");

async function setup() {
  const feed = await loadFeed(MINI, parseDate("2026-11-10"));
  const timetable = buildTimetable(feed);
  const index = new StopIndex(feed.stops);
  const stops = (name: string) => (index.find(name) as { stops: number[] }).stops;
  const query = (from: string, to: string, time: string, windowMinutes: number, maxTransfers = 4) => ({
    from: stops(from),
    to: stops(to),
    departAt: parseClock(time),
    maxTransfers,
    window: windowMinutes * 60,
  });
  return { feed, timetable, query };
}

/** "08:05->08:30 0" */
const brief = (j: Journey) => `${formatClock(j.departure)}->${formatClock(j.arrival)} ${j.transfers}`;

describe("departureTimes", () => {
  it("lists departures from the origin in the window, latest first, then the start time", async () => {
    const { timetable, query } = await setup();
    // At Alpha: line 1 at 08:00 and 08:10, line 300 at 08:00 and 08:05; line 11 (09:00) is
    // outside the window, the night bus too.
    expect(departureTimes(timetable, query("Alpha", "Delta", "07:50", 60)).map(formatClock)).toEqual([
      "08:10",
      "08:05",
      "08:00",
      "07:50",
    ]);
  });

  it("counts a walk to a nearby stop before the departure", async () => {
    const { timetable, query } = await setup();
    // Bravo Gate has no service. Bravo 2 is a 60 s walk away (line 200 at 08:08 and 08:18,
    // line 9 passes at 08:20), Bravo 1 a 119 s walk (line 1 at 08:05 and 08:15; line 8 doesn't
    // pick up there).
    expect(departureTimes(timetable, query("Bravo Gate", "Delta", "08:00", 30)).map(formatClock)).toEqual([
      "08:19",
      "08:17",
      "08:13",
      "08:07",
      "08:03",
      "08:00",
    ]);
  });
});

describe("profile", () => {
  it("keeps every journey not beaten in departure, arrival and transfers", async () => {
    const { timetable, query } = await setup();
    expect(profile(timetable, query("Alpha", "Delta", "07:50", 60)).map(brief)).toEqual([
      "08:00->08:15 1", // line 1 + walk + line 200
      "08:05->08:30 0", // the express: leaves later than the first, but direct
      "08:10->08:25 1", // the second line 1 + line 200
    ]);
    // The slow 08:00 bus (arr 08:40) is beaten by the express; the night bus is outside the window.
  });

  it("keeps a direct journey that a later one with a change arrives before", async () => {
    // Labels are compared within their own round. Comparing with the best arrival over all
    // rounds would let 08:10->08:25 (1 change, found first) hide 08:05->08:30 (direct).
    const { timetable, query } = await setup();
    const journeys = profile(timetable, query("Alpha", "Delta", "08:01", 15));
    expect(journeys.map(brief)).toEqual(["08:05->08:30 0", "08:10->08:25 1"]);
  });

  it("finds the next journey when nothing leaves in the window", async () => {
    const { timetable, query } = await setup();
    expect(profile(timetable, query("Alpha", "Delta", "08:20", 10)).map(brief)).toEqual(["23:55->00:30 (+1) 0"]);
  });
});

describe("plan with a window", () => {
  it("leaves as late as still arrives as early", async () => {
    const { feed, timetable, query } = await setup();
    // Line 9 at 08:20 and at 08:23 both make the 08:30 bus at Foxtrot South (arr 08:40).
    const [earliest] = plan(timetable, query("Charlie", "Echo", "08:15", 0));
    const [latest] = plan(timetable, query("Charlie", "Echo", "08:15", 30));
    expect([brief(earliest!), brief(latest!)]).toEqual(["08:20->08:40 1", "08:23->08:40 1"]);
    expect(feed.trips.find((t) => t.id === (latest!.legs[0] as { tripId: string }).tripId)!.id).toBe("L9b");
  });

  it("gives the same arrivals as without a window", async () => {
    const { timetable, query } = await setup();
    for (const [from, to, time] of [
      ["Alpha", "Delta", "08:00"],
      ["Alpha", "Delta", "07:59"],
      ["Bravo", "Charlie", "08:00"],
      ["Charlie", "Echo", "08:15"],
      ["Alpha", "Echo", "08:55"],
    ] as const) {
      const without = plan(timetable, query(from, to, time, 0)).map((j) => [j.arrival, j.transfers]);
      const within = plan(timetable, query(from, to, time, 60)).map((j) => [j.arrival, j.transfers]);
      expect(within, `${from} -> ${to} at ${time}`).toEqual(without);
    }
  });
});

describe("cli", () => {
  async function run(...args: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main([...args, "--no-cache"], { out: (l) => out.push(l), err: (l) => err.push(l), now: () => new Date(2026, 10, 10, 8) });
    return { code, out: out.join("\n"), err: err.join("\n") };
  }

  it("--list prints every journey in the window", async () => {
    const { code, out } = await run("plan", "--gtfs", MINI, "--from", "Alpha", "--to", "Delta", "--time", "07:50", "--list");
    expect(code).toBe(0);
    expect(out.split("\n").filter((l) => /^\d\d:\d\d -> /.test(l))).toEqual([
      "08:00 -> 08:15  (15 min, 1 transfer)",
      "08:05 -> 08:30  (25 min, direct)",
      "08:10 -> 08:25  (15 min, 1 transfer)",
    ]);
  });

  it("--window 0 leaves as early as possible", async () => {
    const { out } = await run("plan", "--gtfs", MINI, "--from", "Charlie", "--to", "Echo", "--time", "08:15", "--window", "0");
    expect(out).toContain("08:20 -> 08:40");
    const { out: windowed } = await run("plan", "--gtfs", MINI, "--from", "Charlie", "--to", "Echo", "--time", "08:15");
    expect(windowed).toContain("08:23 -> 08:40");
  });

  it.each(["-5", "1441", "soon"])("rejects --window %s", async (value) => {
    const { code, err } = await run("plan", "--gtfs", MINI, "--from", "Alpha", "--to", "Delta", `--window=${value}`);
    expect(code).toBe(2);
    expect(err).toContain("--window must be");
  });
});

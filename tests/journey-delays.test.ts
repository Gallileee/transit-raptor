/**
 * Live delays on the rides of a journey (Planner.plan with a live source), on the test feed.
 * Tuesday 10 Nov 2026, 07:58, Alpha -> Delta at 08:00:
 *
 *   direct:   bus 300 (L3express) Alpha 08:05 -> Delta 08:30
 *   via Bravo: tram 1 (L1a) Alpha 08:00 -> Bravo (1) 08:05, walk to Bravo (2) (about a minute),
 *             bus 200 (L2a) Bravo (2) 08:08 -> Delta 08:15: about two minutes to spare.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type LiveDeparture, type LiveQuery, liveKey, type Realtime, RealtimeError } from "../src/realtime.js";
import { journeyJson, type LegJson, Planner } from "../src/service.js";

const MINI = join(import.meta.dirname, "fixtures", "mini");

class FakeRealtime implements Realtime {
  asked: LiveQuery[] = [];
  constructor(private readonly answer: Map<string, LiveDeparture> | Error) {}
  departures(query: LiveQuery) {
    this.asked.push(query);
    return this.answer instanceof Error ? Promise.reject(this.answer) : Promise.resolve(this.answer);
  }
}

const late = (trip: string, stop: string, delay: number | null, canceled = false): [string, LiveDeparture] => [
  liveKey(trip, stop),
  { delay, canceled, atStop: false, platform: null },
];

type Ride = Extract<LegJson, { kind: "ride" }>;

async function journeys(live: Map<string, LiveDeparture> | Error | undefined, now = new Date(2026, 10, 10, 7, 58), more = {}) {
  const lines: string[] = [];
  const planner = new Planner(MINI, () => now, 2, (l) => lines.push(l));
  const fake = live === undefined ? undefined : new FakeRealtime(live);
  planner.realtime = fake;
  const answer = await planner.plan({ from: "alpha", to: "delta", date: "2026-11-10", time: "08:00", window: 0, ...more });
  const rides = answer.journeys.map((j) => j.legs.filter((l): l is Ride => l.kind === "ride"));
  return { answer, rides, fake, lines };
}

const summary = (rides: Ride[][]) => rides.map((r) => r.map((l) => [l.line, l.delay, l.canceled, l.changeAtRisk]));

describe("live delays in journeys", () => {
  it("puts each ride's delay on it, asking once for every stop where one gets on", async () => {
    const { answer, rides, fake } = await journeys(new Map([late("L3express", "A", 60), late("L1a", "A", 20), late("L2a", "B2", null)]));
    expect(answer.live).toBe("on");
    expect(summary(rides)).toEqual([
      [["300", 60, false, false]],
      [
        ["1", 20, false, false],
        ["200", null, false, false],
      ],
    ]);
    expect(fake!.asked).toEqual([{ stopIds: ["A", "B2"], from: "2026-11-10T07:58:00", before: 5, minutes: 61, limit: 1000 }]);
  });

  it("warns when the vehicle before is late enough to miss the change", async () => {
    // Tram 1 two and a half minutes late: at Bravo 08:07:30, on foot to platform 2 after 08:08.
    const { rides } = await journeys(new Map([late("L1a", "A", 150)]));
    expect(summary(rides)[1]).toEqual([
      ["1", 150, false, false],
      ["200", null, false, true],
    ]);
  });

  it("doesn't warn when the time to spare covers the delay, or the next vehicle is late too", async () => {
    expect(summary((await journeys(new Map([late("L1a", "A", 60)]))).rides)[1]![1]).toEqual(["200", null, false, false]);
    expect(summary((await journeys(new Map([late("L1a", "A", 150), late("L2a", "B2", 90)]))).rides)[1]![1]).toEqual(["200", 90, false, false]);
    // The next vehicle's delay counts: a minute late was fine; with the bus on time, still fine.
    expect(summary((await journeys(new Map([late("L1a", "A", 60), late("L2a", "B2", 0)]))).rides)[1]![1]).toEqual(["200", 0, false, false]);
  });

  it("counts only the walk of each change, not walks before it", async () => {
    // Built by hand: walk 5 min to S1, ride T1 S1 08:00 -> S2 08:10, ride T2 from S2 08:12.
    const planner = new Planner(MINI, () => new Date(2026, 10, 10, 7, 54));
    const loaded = await planner.load({ year: 2026, month: 11, day: 10 });
    const [s0, s1, s2] = ["A", "C", "D"].map((id) => loaded.feed.stopById.get(id)!);
    const at = (h: number, m: number) => h * 3600 + m * 60;
    const journey = {
      departure: at(7, 55),
      arrival: at(8, 20),
      transfers: 1,
      legs: [
        { kind: "walk" as const, from: s0!, to: s1!, departure: at(7, 55), arrival: at(8, 0) },
        { kind: "ride" as const, routeId: "L3", tripId: "T1", headsign: "", from: s1!, to: s2!, departure: at(8, 0), arrival: at(8, 10), stopCount: 1 },
        { kind: "ride" as const, routeId: "L3", tripId: "T2", headsign: "", from: s2!, to: s0!, departure: at(8, 12), arrival: at(8, 20), stopCount: 1 },
      ],
    };
    const live = new Map([late("T1", "C", 60)]); // arrives 08:11, the next leaves 08:12
    const legs = journeyJson(loaded, journey, loaded.timetable, live).legs as Ride[];
    expect(legs.map((l) => [l.kind, l.kind === "ride" ? l.changeAtRisk : null])).toEqual([
      ["walk", null],
      ["ride", false],
      ["ride", false],
    ]);
  });

  it("gets on at the platform live data give, if any", async () => {
    const { answer } = await journeys(
      new Map<string, LiveDeparture>([[liveKey("L1a", "A"), { delay: 0, canceled: false, atStop: false, platform: "5J" }]]),
    );
    const [direct, viaBravo] = answer.journeys.map((j) => j.legs.filter((l): l is Ride => l.kind === "ride"));
    expect(viaBravo!.map((r) => [r.line, r.from.platform, r.to.platform])).toEqual([
      ["1", "5J", "1"],
      ["200", "2", ""],
    ]);
    expect(direct![0]!.from.platform).toBe(""); // nothing live for it
  });

  it("says when a ride is cancelled", async () => {
    const { rides } = await journeys(new Map([late("L3express", "A", 0, true)]));
    expect(summary(rides)[0]).toEqual([["300", 0, true, false]]);
  });

  it("only asks for rides leaving within the next hour, on the day of the journey", async () => {
    // At 06:50 nothing of 08:00 leaves within the hour.
    const early = await journeys(new Map([late("L1a", "A", 150)]), new Date(2026, 10, 10, 6, 50));
    expect([early.answer.live, early.fake!.asked]).toEqual(["off", []]);
    expect(summary(early.rides)[1]![0]).toEqual(["1", null, false, false]);
    // The day before: off as well.
    const before = await journeys(new Map(), new Date(2026, 10, 9, 23, 0));
    expect([before.answer.live, before.fake!.asked]).toEqual(["off", []]);
    // After midnight, a journey of the day before (night bus 905, Charlie 24:10) isn't asked
    // about either: Golemio's day is the new one.
    const night = await journeys(new Map(), new Date(2026, 10, 11, 0, 5), { from: "charlie", time: "23:50" });
    expect(night.rides.flat().map((r) => [r.line, r.departure])).toEqual([["905", "00:10 (+1)"]]);
    expect([night.answer.live, night.fake!.asked]).toEqual(["off", []]);
  });

  it("plans as before when the source fails or there is none", async () => {
    const failed = await journeys(new RealtimeError("HTTP 503"));
    expect(failed.answer.live).toBe("error");
    expect(failed.lines).toEqual(["live: no delays (HTTP 503); showing the timetable"]);
    expect(summary(failed.rides).flat().every(([, delay, canceled, risk]) => delay === null && !canceled && !risk)).toBe(true);
    const none = await journeys(undefined);
    expect(none.answer.live).toBe("off");
    expect(summary(none.rides)).toEqual(summary(failed.rides));
  });
});

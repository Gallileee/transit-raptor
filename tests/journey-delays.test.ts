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
import { plan } from "../src/raptor.js";
import { cancelledRides, fallbackFor, journeyJson, type LegJson, Planner } from "../src/service.js";

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

  describe("plans around rides live data say are cancelled", () => {
    const trips = (answer: { journeys: { legs: LegJson[] }[] }) =>
      answer.journeys.map((j) => j.legs.filter((l): l is Ride => l.kind === "ride").map((r) => `${r.line} ${r.departure}`));

    it("searches again without them, and says which", async () => {
      // Bus 300 at 08:05 cancelled: the slow one at 08:00 instead, direct.
      const { answer, fake } = await journeys(new Map([late("L3express", "A", 0, true)]));
      expect(trips(answer)).toEqual([["300 08:00"], ["1 08:00", "200 08:08"]]);
      expect(answer.avoided).toEqual([
        { mode: "bus", line: "300", headsign: "Delta, Náměstí", from: expect.objectContaining({ name: "Alpha" }), departure: "08:05" },
      ]);
      expect(answer.journeys.flatMap((j) => j.legs).some((l) => l.kind === "ride" && l.canceled)).toBe(false);
      expect(fake!.asked).toHaveLength(2); // the new journeys asked about too
    });

    it("goes around the ones the new journeys meet as well", async () => {
      // Bus 200 at 08:08 cancelled, then the 08:18 one: via Bravo is gone; bus 300 is left.
      const { answer, fake } = await journeys(new Map([late("L2a", "B2", 0, true), late("L2b", "B2", 0, true)]));
      expect(trips(answer)).toEqual([["300 08:05"]]);
      expect(answer.avoided.map((a) => `${a.line} ${a.departure}`)).toEqual(["200 08:08", "200 08:18"]);
      expect(fake!.asked).toHaveLength(3);
    });

    it("says nothing was avoided when nothing is cancelled, or there is no live data", async () => {
      const { answer, fake } = await journeys(new Map([late("L1a", "A", 60)]));
      expect([answer.avoided, fake!.asked.length]).toEqual([[], 1]);
      expect((await journeys(undefined)).answer.avoided).toEqual([]);
      expect((await journeys(new RealtimeError("HTTP 503"))).answer.avoided).toEqual([]);
    });

    it("lists a trip once, though several journeys take it", async () => {
      const planner = new Planner(MINI, () => new Date(2026, 10, 10, 7, 58));
      const loaded = await planner.load({ year: 2026, month: 11, day: 10 });
      const [a, b2, d] = ["A", "B2", "D"].map((id) => loaded.feed.stopById.get(id)!);
      const viaBravo = plan(loaded.timetable, { from: [a!], to: [d!], departAt: 8 * 3600, maxTransfers: 4 })[1]!;
      const fromBravo = plan(loaded.timetable, { from: [b2!], to: [d!], departAt: 8 * 3600, maxTransfers: 4 })[0]!;
      const found = cancelledRides(loaded, [viaBravo, fromBravo], new Map([late("L2a", "B2", 0, true)]));
      expect(found.map((c) => [c.tripId, c.json.line, c.json.departure])).toEqual([["L2a", "200", "08:08"]]);
    });

    it("plans around them in a list of journeys too", async () => {
      const { answer } = await journeys(new Map([late("L1a", "A", 0, true)]), undefined, { list: true, window: 15 });
      expect(trips(answer).flat()).not.toContain("1 08:00");
      expect(answer.avoided.map((a) => `${a.line} ${a.departure}`)).toEqual(["1 08:00"]);
    });
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

  describe("if a change at risk is missed, or a ride is cancelled", () => {
    const fallbackOf = async (live: Map<string, LiveDeparture>) => (await journeys(live)).answer.journeys.map((j) => j.fallback);
    const rides = (journey: { legs: LegJson[] } | null | undefined) =>
      journey?.legs.filter((l): l is Ride => l.kind === "ride").map((r) => [r.line, stopName(r.from), r.departure, r.arrival, r.delay]);
    const stopName = (s: { name: string; platform: string }) => (s.platform ? `${s.name} (${s.platform})` : s.name);

    it("searches on from where the late vehicle leaves one, when it is expected there", async () => {
      // Tram 1 at Bravo (1) 08:07:30, bus 200 at 08:08 gone: the next one, 08:18, arrives 08:25.
      const [direct, viaBravo] = await fallbackOf(new Map([late("L1a", "A", 150)]));
      expect(direct).toBeUndefined();
      expect({ ...viaBravo!, journey: rides(viaBravo!.journey) }).toEqual({
        leg: 2,
        reason: "late",
        from: expect.objectContaining({ name: "Bravo", platform: "1" }),
        at: "08:07",
        journey: [["200", "Bravo (2)", "08:18", "08:25", null]],
        later: 10,
      });
      expect(viaBravo!.journey!.arrival).toBe("08:25");
    });

    it("isn't there when no change is at risk", async () => {
      expect(await fallbackOf(new Map([late("L1a", "A", 60)]))).toEqual([undefined, undefined]);
      expect(await fallbackOf(new Map([late("L1a", "A", 150), late("L2a", "B2", 90)]))).toEqual([undefined, undefined]);
      expect(await fallbackOf(new Map())).toEqual([undefined, undefined]);
    });

    it("gives the next vehicle's delay too, when it is known", async () => {
      const [, viaBravo] = await fallbackOf(new Map([late("L1a", "A", 150), late("L2b", "B2", 120)]));
      expect(rides(viaBravo!.journey)).toEqual([["200", "Bravo (2)", "08:18", "08:25", 120]]);
    });

    it("says when nothing goes on from there", async () => {
      // Tram 1 25 minutes late: at Bravo 08:30, after the last bus to Delta.
      const [, viaBravo] = await fallbackOf(new Map([late("L1a", "A", 25 * 60)]));
      expect(viaBravo).toEqual({ leg: 2, reason: "late", from: expect.objectContaining({ name: "Bravo" }), at: "08:30", journey: null, later: null });
    });

    it("takes the journey that arrives first, even with more changes", async () => {
      // Built by hand: a ride into Alpha 2 minutes late (08:01), the 08:00 bus 400 from there
      // gone. From Alpha at 08:01: bus 300 direct, at Delta 08:30, or tram 1 and bus 200, 08:25.
      const planner = new Planner(MINI, () => new Date(2026, 10, 10, 7, 50));
      const loaded = await planner.load({ year: 2026, month: 11, day: 10 });
      const [a, c, d] = ["A", "C", "D"].map((id) => loaded.feed.stopById.get(id)!);
      const at = (h: number, m: number) => h * 3600 + m * 60;
      const journey = {
        departure: at(7, 50),
        arrival: at(8, 40),
        transfers: 1,
        legs: [
          { kind: "ride" as const, routeId: "L3", tripId: "T1", headsign: "", from: c!, to: a!, departure: at(7, 50), arrival: at(7, 59), stopCount: 1 },
          { kind: "ride" as const, routeId: "L3", tripId: "L3slow", headsign: "", from: a!, to: d!, departure: at(8, 0), arrival: at(8, 40), stopCount: 2 },
        ],
      };
      const live = new Map([late("T1", "C", 120)]);
      const json = journeyJson(loaded, journey, loaded.timetable, live);
      const fallback = fallbackFor(loaded, journey, json, loaded.timetable, live, { from: [c!], to: [d!], maxTransfers: 4 })!;
      expect([fallback.at, rides(fallback.journey), fallback.later]).toEqual([
        "08:01",
        [
          ["1", "Alpha", "08:10", "08:15", null],
          ["200", "Bravo (2)", "08:18", "08:25", null],
        ],
        -15,
      ]);
    });

    // A cancelled ride is planned around (above), so the journeys the planner returns don't have
    // one while it can search again; these give fallbackFor the journeys of the timetable.
    const timetableFallbacks = async (live: Map<string, LiveDeparture>, from = "alpha", skip?: Set<string>) => {
      const planner = new Planner(MINI, () => new Date(2026, 10, 10, 7, 58));
      const loaded = await planner.load({ year: 2026, month: 11, day: 10 });
      const match = loaded.index.find(from);
      const query = { from: match.kind === "found" ? match.stops : [], to: [loaded.feed.stopById.get("D")!], maxTransfers: 4, ...(skip ? { skip } : {}) };
      return plan(loaded.timetable, { ...query, departAt: 8 * 3600 }).map((j) =>
        fallbackFor(loaded, j, journeyJson(loaded, j, loaded.timetable, live), loaded.timetable, live, query),
      );
    };

    it("goes on without a cancelled ride, from where the ride before leaves one", async () => {
      // Bus 200 at 08:08 cancelled, tram 1 on time at Bravo (1) 08:05: the 08:18 bus, not the
      // cancelled one, though there would be time for it.
      const [direct, viaBravo] = await timetableFallbacks(new Map([late("L1a", "A", 0), late("L2a", "B2", 0, true)]));
      expect(direct).toBeUndefined();
      expect({ ...viaBravo!, journey: rides(viaBravo!.journey) }).toEqual({
        leg: 2,
        reason: "canceled",
        from: expect.objectContaining({ name: "Bravo", platform: "1" }),
        at: "08:05",
        journey: [["200", "Bravo (2)", "08:18", "08:25", null]],
        later: 10,
      });
      // Late and cancelled: the cancellation is the reason.
      const [, both] = await timetableFallbacks(new Map([late("L1a", "A", 150), late("L2a", "B2", 0, true)]));
      expect([both!.reason, both!.at, rides(both!.journey)]).toEqual(["canceled", "08:07", [["200", "Bravo (2)", "08:18", "08:25", null]]]);
    });

    it("goes on from where the journey starts when its first ride is cancelled", async () => {
      // Bus 300 at 08:05 cancelled: from Alpha at 08:05, tram 1 at 08:10 and bus 200, at 08:25.
      const [direct] = await timetableFallbacks(new Map([late("L3express", "A", 0, true)]));
      expect({ ...direct!, journey: rides(direct!.journey) }).toEqual({
        leg: 0,
        reason: "canceled",
        from: expect.objectContaining({ name: "Alpha" }),
        at: "08:05",
        journey: [
          ["1", "Alpha", "08:10", "08:15", null],
          ["200", "Bravo (2)", "08:18", "08:25", null],
        ],
        later: -5,
      });
      // The place searched from, not the platform of the cancelled ride (bus 200 at Bravo (2)).
      const fallback = (await timetableFallbacks(new Map([late("L2a", "B2", 0, true)]), "bravo"))[0]!;
      expect([fallback.from.name, fallback.from.platform, fallback.at, rides(fallback.journey)]).toEqual([
        "Bravo",
        "",
        "08:08",
        [["200", "Bravo (2)", "08:18", "08:25", null]],
      ]);
    });

    it("doesn't take a trip planned around, though the live data asked last don't mention it", async () => {
      // As above, but bus 200 at 08:18 is known cancelled only from an earlier search round.
      const [, viaBravo] = await timetableFallbacks(new Map([late("L1a", "A", 150)]), "alpha", new Set(["L2b"]));
      expect(rides(viaBravo!.journey)!.map((r) => `${r[0]} ${r[2]}`)).toEqual(["1 08:15", "300 08:20"]);
    });

    it("for a cancelled first ride, searches from any stop the search could start at", async () => {
      // Built by hand: searching from Alpha or Foxtrot South to Echo, the journey's first ride
      // (from Alpha) is cancelled. From Alpha alone the next way is at Echo 09:20; one who
      // hasn't left can go from Foxtrot South instead: 08:30, at Echo 08:40.
      const planner = new Planner(MINI, () => new Date(2026, 10, 10, 7, 50));
      const loaded = await planner.load({ year: 2026, month: 11, day: 10 });
      const [a, f2, e] = ["A", "F2", "E"].map((id) => loaded.feed.stopById.get(id)!);
      const at = (h: number, m: number) => h * 3600 + m * 60;
      const journey = {
        departure: at(8, 0),
        arrival: at(8, 50),
        transfers: 0,
        legs: [{ kind: "ride" as const, routeId: "L10", tripId: "X", headsign: "", from: a!, to: e!, departure: at(8, 0), arrival: at(8, 50), stopCount: 1 }],
      };
      const live = new Map([late("X", "A", 0, true)]);
      const json = journeyJson(loaded, journey, loaded.timetable, live);
      const fallback = fallbackFor(loaded, journey, json, loaded.timetable, live, { from: [a!, f2!], to: [e!], maxTransfers: 4 })!;
      expect([fallback.reason, fallback.from.name, fallback.from.platform, fallback.at]).toEqual(["canceled", "Alpha", "", "08:00"]);
      expect([rides(fallback.journey)!.map((r) => r[1]), fallback.journey!.arrival, fallback.later]).toEqual([["Foxtrot South"], "08:40", -10]);
    });

    it("doesn't take another trip live data say is cancelled", async () => {
      // Tram 1 late, so bus 200 at 08:08 may be gone, and the 08:18 one is cancelled: on with
      // the next tram 1 to Charlie and the slow bus 300 from there, at Delta 08:40.
      const [, viaBravo] = await fallbackOf(new Map([late("L1a", "A", 150), late("L2b", "B2", 0, true)]));
      expect([viaBravo!.reason, rides(viaBravo!.journey), viaBravo!.later]).toEqual([
        "late",
        [
          ["1", "Bravo (1)", "08:15", "08:20", null],
          ["300", "Charlie", "08:20", "08:40", null],
        ],
        25,
      ]);
    });
  });

  describe("RAPTOR's skip", () => {
    it("passes over the trips given, catching the next one of the line", async () => {
      const planner = new Planner(MINI, () => new Date(2026, 10, 10, 7, 50));
      const loaded = await planner.load({ year: 2026, month: 11, day: 10 });
      const [a, d] = ["A", "D"].map((id) => loaded.feed.stopById.get(id)!);
      const trips = (skip?: string[]) =>
        plan(loaded.timetable, { from: [a!], to: [d!], departAt: 8 * 3600, maxTransfers: 4, ...(skip ? { skip: new Set(skip) } : {}) }).map((j) =>
          j.legs.flatMap((l) => (l.kind === "ride" ? [l.tripId] : [])),
        );
      expect(trips()).toEqual([["L3express"], ["L1a", "L2a"]]);
      expect(trips(["L1a"])).toEqual([["L3express"], ["L1b", "L2b"]]);
      expect(trips(["L2a"])).toEqual([["L3express"], ["L1a", "L2b"]]);
      expect(trips(["L3express", "L1a", "L1b"])).toEqual([["L3slow"]]);
      expect(trips([])).toEqual(trips());
    });
  });
});

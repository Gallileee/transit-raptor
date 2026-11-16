/**
 * Live delays (src/realtime.ts) against a fake Golemio on a local port, and their use on the
 * departures board (Planner, CLI). No real key and no internet: the fake checks what a real
 * request would carry.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { delayText, main } from "../src/cli.js";
import { GolemioRealtime, type LiveDeparture, type LiveQuery, liveKey, type Realtime, RealtimeError } from "../src/realtime.js";
import { Planner } from "../src/service.js";

const MINI = join(import.meta.dirname, "fixtures", "mini");
const KEY = "test-key-not-real";

/** The test feed's ids: bus 300 slow (L3slow) and express (L3express), tram 1 (L1a) at Alpha (A). */
const GOLEMIO_ANSWER = {
  stops: [],
  infotexts: [],
  departures: [
    { delay: { is_available: true, minutes: 2, seconds: 150 }, stop: { id: "A", platform_code: "4J" }, trip: { id: "L3slow", is_canceled: false, is_at_stop: false } },
    // Not available: whatever the seconds say, the delay isn't known.
    { delay: { is_available: false, minutes: 0, seconds: 0 }, stop: { id: "A", platform_code: null }, trip: { id: "L1a", is_canceled: false, is_at_stop: true } },
    { delay: { is_available: true, minutes: 0, seconds: 20 }, stop: { id: "A", platform_code: " " }, trip: { id: "L3express", is_canceled: true, is_at_stop: false } },
    // Ahead of time, or waiting at its first stop: on time (PID's vehicles don't leave early).
    { delay: { is_available: true, minutes: -3, seconds: -185 }, stop: { id: "B2" }, trip: { id: "L2a", is_canceled: false, is_at_stop: true } },
    { delay: { is_available: true, seconds: 60 }, stop: {}, trip: { id: "no-stop" } }, // skipped
  ],
};

let requests: IncomingMessage[] = [];
let reply: (req: IncomingMessage) => { status: number; body: string } | "hang" = () => ({ status: 200, body: JSON.stringify(GOLEMIO_ANSWER) });
const server: Server = createServer((req, res) => {
  requests.push(req);
  const answer = reply(req);
  if (answer === "hang") return; // never answers
  res.writeHead(answer.status, { "Content-Type": "application/json" });
  res.end(answer.body);
});
let base = "";
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
});
afterEach(() => {
  requests = [];
  reply = () => ({ status: 200, body: JSON.stringify(GOLEMIO_ANSWER) });
});

const QUERY: LiveQuery = { stopIds: ["B2", "A"], from: "2026-11-10T07:58:00", before: 15, minutes: 120, limit: 60 };

describe("GolemioRealtime", () => {
  it("asks for the stops' departures with the key in the header, and reads delays by trip and stop", async () => {
    const live = await new GolemioRealtime(KEY, { baseUrl: base }).departures(QUERY);
    expect(requests).toHaveLength(1);
    const url = new URL(requests[0]!.url!, base);
    expect(url.pathname).toBe("/v2/pid/departureboards");
    expect([...url.searchParams]).toEqual([
      ["ids", "A"],
      ["ids", "B2"],
      ["timeFrom", "2026-11-10T07:58:00"],
      ["minutesBefore", "15"],
      ["minutesAfter", "120"],
      ["limit", "60"],
      ["mode", "departures"],
      ["order", "timetable"],
    ]);
    expect(requests[0]!.headers["x-access-token"]).toBe(KEY);
    expect(requests[0]!.url).not.toContain(KEY);
    expect([...live]).toEqual([
      [liveKey("L3slow", "A"), { delay: 150, canceled: false, atStop: false, platform: "4J" }], // a train's track
      [liveKey("L1a", "A"), { delay: null, canceled: false, atStop: true, platform: null }],
      [liveKey("L3express", "A"), { delay: 20, canceled: true, atStop: false, platform: null }],
      [liveKey("L2a", "B2"), { delay: 0, canceled: false, atStop: true, platform: null }],
    ]);
  });

  it("asks once for the same board within 20 s, shares a request in flight, and asks again later", async () => {
    let now = 1_000_000;
    const golemio = new GolemioRealtime(KEY, { baseUrl: base, now: () => now });
    await Promise.all([golemio.departures(QUERY), golemio.departures(QUERY)]);
    expect(requests).toHaveLength(1);
    now += 19_000;
    await golemio.departures({ ...QUERY, stopIds: ["A", "B2"] }); // same stops, other order
    expect(requests).toHaveLength(1);
    await golemio.departures({ ...QUERY, from: "2026-11-10T07:59:00" });
    expect(requests).toHaveLength(2);
    now += 2_000;
    await golemio.departures(QUERY);
    expect(requests).toHaveLength(3);
  });

  it("fails with a RealtimeError that says why, and doesn't keep the failure", async () => {
    const golemio = new GolemioRealtime(KEY, { baseUrl: base, timeoutMs: 200 });
    reply = () => ({ status: 401, body: "{}" });
    await expect(golemio.departures(QUERY)).rejects.toThrow(new RealtimeError("the API key was refused (401)"));
    reply = () => ({ status: 503, body: "{}" });
    await expect(golemio.departures(QUERY)).rejects.toThrow("HTTP 503");
    reply = () => ({ status: 200, body: "<html>" });
    await expect(golemio.departures(QUERY)).rejects.toThrow("not JSON");
    reply = () => "hang";
    await expect(golemio.departures(QUERY)).rejects.toThrow("no answer in time");
    reply = () => ({ status: 200, body: JSON.stringify(GOLEMIO_ANSWER) });
    expect((await golemio.departures(QUERY)).size).toBe(4);
    await expect(new GolemioRealtime(KEY, { baseUrl: "http://127.0.0.1:9" }).departures(QUERY)).rejects.toThrow("can't be reached");
  });

  describe("past Golemio's 100 departures an answer", () => {
    // A board of trips P0, P1, ... at stop A, one a minute from `start` (Prague time, as
    // Golemio gives it), the way Golemio answers: at most 100, in timetable order.
    const departure = (n: number, at: string) => ({
      delay: { is_available: true, seconds: n },
      stop: { id: "A" },
      trip: { id: `P${n}`, is_canceled: false, is_at_stop: false },
      departure_timestamp: { scheduled: `${at}+01:00` },
    });
    const minute = (base: string, n: number) => new Date(Date.parse(`${base}Z`) + n * 60_000).toISOString().slice(0, 19);
    const START = "2026-11-10T07:43:00"; // a quarter of an hour before the board (07:58)
    /** Departures every minute from START, up to `last` (a minute number): answers what is asked. */
    const answering = (last: number, sameMinute = false) => (req: IncomingMessage) => {
      const url = new URL(req.url!, base);
      const from = Date.parse(`${url.searchParams.get("timeFrom")}Z`);
      const lo = from - Number(url.searchParams.get("minutesBefore")) * 60_000;
      const hi = from + Number(url.searchParams.get("minutesAfter")) * 60_000;
      const all = Array.from({ length: last + 1 }, (_, n) => departure(n, sameMinute ? START : minute(START, n)));
      const inside = all.filter((d) => {
        const t = Date.parse(`${d.departure_timestamp.scheduled.slice(0, 19)}Z`);
        return t >= lo && t <= hi;
      });
      const limit = Math.min(100, Number(url.searchParams.get("limit")));
      return { status: 200, body: JSON.stringify({ departures: inside.slice(0, limit) }) };
    };
    const asked = () =>
      requests.map((r) => {
        const q = new URL(r.url!, base).searchParams;
        return [q.get("timeFrom"), q.get("minutesBefore"), q.get("minutesAfter"), q.get("limit")];
      });
    const HOUR: LiveQuery = { stopIds: ["A"], from: "2026-11-10T07:58:00", before: 15, minutes: 120, limit: 1000 };

    it("asks again from the last scheduled time while answers are full, going back a little", async () => {
      // 07:43 to 09:58 every minute: 136 departures; the first answer ends at P99, 09:22.
      reply = answering(135);
      const live = await new GolemioRealtime(KEY, { baseUrl: base }).departures(HOUR);
      expect(asked()).toEqual([
        ["2026-11-10T07:58:00", "15", "120", "100"],
        // From 09:17 (5 minutes before 09:22) to a minute past the end (09:58): 42 minutes.
        ["2026-11-10T09:17:00", "0", "42", "100"],
      ]);
      expect(live.size).toBe(136);
      expect(live.get(liveKey("P135", "A"))).toEqual({ delay: 135, canceled: false, atStop: false, platform: null });
    });

    it("counts a full answer by what Golemio sent, not by what could be read", async () => {
      // P5 comes without a stop: 99 departures read, but the answer was full.
      reply = (req) => {
        const body = JSON.parse(answering(135)(req).body);
        for (const d of body.departures) if (d.trip.id === "P5") d.stop = {};
        return { status: 200, body: JSON.stringify(body) };
      };
      expect((await new GolemioRealtime(KEY, { baseUrl: base }).departures(HOUR)).size).toBe(135);
      expect(requests).toHaveLength(2);
    });

    it("keeps what the first page said about a departure on two pages", async () => {
      let second = false;
      reply = (req) => {
        const answer = answering(135)(req);
        if (!second) {
          second = true;
          return answer;
        }
        const body = JSON.parse(answer.body);
        for (const d of body.departures) d.delay.seconds = 999;
        return { status: 200, body: JSON.stringify(body) };
      };
      const live = await new GolemioRealtime(KEY, { baseUrl: base }).departures(HOUR);
      expect([live.get(liveKey("P99", "A"))!.delay, live.get(liveKey("P100", "A"))!.delay]).toEqual([99, 999]);
    });

    it("asks once when the answer isn't full, or no more than 100 are wanted", async () => {
      reply = answering(99); // exactly 100, full, but the window ends at the last one
      expect((await new GolemioRealtime(KEY, { baseUrl: base }).departures({ ...HOUR, minutes: 99 - 15 })).size).toBe(100);
      expect(asked()).toHaveLength(1);
      requests = [];
      reply = answering(60);
      expect((await new GolemioRealtime(KEY, { baseUrl: base }).departures(HOUR)).size).toBe(61);
      requests = [];
      reply = answering(300);
      const golemio = new GolemioRealtime(KEY, { baseUrl: base });
      expect((await golemio.departures({ ...HOUR, limit: 100 })).size).toBe(100);
      expect(asked()).toEqual([["2026-11-10T07:58:00", "15", "120", "100"]]);
      // The same first request, with more wanted: not the answer kept for 100. (137: the page
      // after goes a minute past the end, to 09:59.)
      expect((await golemio.departures(HOUR)).size).toBe(137);
      expect(asked()).toHaveLength(3);
    });

    it("stops at the limit, after 5 pages, or when the pages don't move on", async () => {
      reply = answering(2000);
      // A day of departures: two pages give 194, past the 150 wanted.
      expect((await new GolemioRealtime(KEY, { baseUrl: base }).departures({ ...HOUR, minutes: 24 * 60, limit: 150 })).size).toBe(194);
      expect(asked()).toHaveLength(2);
      requests = [];
      const day = await new GolemioRealtime(KEY, { baseUrl: base }).departures({ ...HOUR, minutes: 24 * 60 });
      expect(asked()).toHaveLength(5);
      expect(day.size).toBe(100 + 4 * 94); // each later page repeats 6 (5 minutes back, and its first)
      requests = [];
      reply = answering(300, true); // all at 07:43
      expect((await new GolemioRealtime(KEY, { baseUrl: base }).departures(HOUR)).size).toBe(100);
      expect(asked()).toHaveLength(2);
    });

    it("fails as a whole when a later page fails, and keeps nothing", async () => {
      const golemio = new GolemioRealtime(KEY, { baseUrl: base });
      reply = (req) => (requests.length === 1 ? answering(135)(req) : { status: 429, body: "{}" });
      await expect(golemio.departures(HOUR)).rejects.toThrow("HTTP 429");
      requests = [];
      reply = answering(135);
      expect((await golemio.departures(HOUR)).size).toBe(136);
      expect(requests).toHaveLength(2);
    });
  });
});

/** A source that answers from a map and remembers what it was asked. */
class FakeRealtime implements Realtime {
  asked: LiveQuery[] = [];
  constructor(private readonly answer: Map<string, LiveDeparture> | Error) {}
  departures(query: LiveQuery) {
    this.asked.push(query);
    return this.answer instanceof Error ? Promise.reject(this.answer) : Promise.resolve(this.answer);
  }
}

describe("live delays on the departures board", () => {
  const live = new Map<string, LiveDeparture>([
    [liveKey("L3slow", "A"), { delay: 150, canceled: false, atStop: false, platform: null }],
    [liveKey("L3express", "A"), { delay: 20, canceled: true, atStop: false, platform: null }],
  ]);
  const board = (planner: Planner, time: string) => planner.departures({ stop: "alpha", date: "2026-11-10", time, limit: 3 });

  it("adds the delays of a board for now, matched by trip and stop", async () => {
    const lines: string[] = [];
    const planner = new Planner(MINI, () => new Date(2026, 10, 10, 7, 58, 40), 2, (l) => lines.push(l));
    const fake = new FakeRealtime(live);
    planner.realtime = fake;
    const answer = await board(planner, "07:58");
    expect(answer.live).toBe("on");
    // In the order they are expected to leave: the late bus after the tram.
    expect(answer.departures.map((d) => [d.departure, d.line, d.delay, d.canceled, d.minutes, d.expectedMinutes])).toEqual([
      ["08:00", "1", null, false, 2, 2],
      ["08:00", "300", 150, false, 2, 4],
      ["08:05", "300", 20, true, 7, 7],
    ]);
    // 15 minutes back, for vehicles late from before now.
    expect(fake.asked).toEqual([{ stopIds: ["A"], from: "2026-11-10T07:58:00", before: 15, minutes: 120, limit: 39 }]);
    expect(lines).toEqual([]);
  });

  it("keeps a vehicle scheduled before now that is late and still to come", async () => {
    const planner = new Planner(MINI, () => new Date(2026, 10, 10, 8, 1, 10));
    planner.realtime = new FakeRealtime(live);
    const answer = await board(planner, "08:01");
    // Tram 1 (08:00, no report) has left; bus 300 (08:00, +2.5 min) hasn't; the cancelled
    // express is shown as cancelled; then tram 1 at 08:10.
    expect(answer.departures.map((d) => [d.departure, d.line, d.minutes, d.expectedMinutes, d.canceled])).toEqual([
      ["08:00", "300", -1, 1, false],
      ["08:05", "300", 4, 4, true],
      ["08:10", "1", 9, 9, false],
    ]);
    // Without live delays nothing before the board's time is shown.
    planner.realtime = undefined;
    expect((await board(planner, "08:01")).departures[0]!.departure).toBe("08:05");
  });

  it("orders by when they are expected, and drops a cancelled trip that was due before now", async () => {
    const planner = new Planner(MINI, () => new Date(2026, 10, 10, 8, 1, 10));
    planner.realtime = new FakeRealtime(
      new Map<string, LiveDeparture>([
        [liveKey("L3slow", "A"), { delay: 400, canceled: false, atStop: false, platform: null }], // 08:00 -> 08:06:40
        [liveKey("L3express", "A"), { delay: 20, canceled: false, atStop: false, platform: null }], // 08:05 -> 08:05:20
        [liveKey("L1a", "A"), { delay: 120, canceled: true, atStop: false, platform: null }], // 08:00, cancelled
      ]),
    );
    expect((await board(planner, "08:01")).departures.map((d) => [d.departure, d.line, d.expectedMinutes])).toEqual([
      ["08:05", "300", 4],
      ["08:00", "300", 5],
      ["08:10", "1", 9],
    ]);
  });

  it("shows the platform live data give (a train's track for the day), and says so", async () => {
    const planner = new Planner(MINI, () => new Date(2026, 10, 10, 7, 58));
    planner.realtime = new FakeRealtime(
      new Map<string, LiveDeparture>([
        [liveKey("L1a", "A"), { delay: 0, canceled: false, atStop: false, platform: "3S" }],
        [liveKey("L3slow", "A"), { delay: 0, canceled: false, atStop: false, platform: "" }],
        [liveKey("L3express", "A"), { delay: 0, canceled: false, atStop: false, platform: null }],
      ]),
    );
    expect((await board(planner, "07:58")).departures.map((d) => [d.line, d.platform, d.platformLive])).toEqual([
      ["1", "3S", true],
      ["300", "", false],
      ["300", "", false],
    ]);
    planner.realtime = undefined;
    expect((await board(planner, "07:58")).departures.every((d) => !d.platformLive)).toBe(true);
  });

  it("doesn't ask for a board more than 5 minutes from now", async () => {
    const planner = new Planner(MINI, () => new Date(2026, 10, 10, 7, 58));
    const fake = new FakeRealtime(live);
    planner.realtime = fake;
    expect((await board(planner, "08:03")).live).toBe("on");
    expect((await board(planner, "08:04")).live).toBe("off");
    expect((await board(planner, "07:52")).live).toBe("off");
    expect(fake.asked).toHaveLength(1);
  });

  it("shows the timetable when the source fails, and logs that at most once a minute", async () => {
    const lines: string[] = [];
    let now = new Date(2026, 10, 10, 7, 58);
    const planner = new Planner(MINI, () => now, 2, (l) => lines.push(l));
    planner.realtime = new FakeRealtime(new RealtimeError("HTTP 503"));
    const answer = await board(planner, "07:58");
    expect(answer.live).toBe("error");
    expect(answer.departures.every((d) => d.delay === null && !d.canceled)).toBe(true);
    await board(planner, "07:58");
    now = new Date(2026, 10, 10, 7, 59, 1);
    await board(planner, "07:59");
    expect(lines).toEqual(["live: no delays (HTTP 503); showing the timetable", "live: no delays (HTTP 503); showing the timetable"]);
  });

  it("lets other errors through, and is off without a source", async () => {
    const planner = new Planner(MINI, () => new Date(2026, 10, 10, 7, 58));
    planner.realtime = new FakeRealtime(new TypeError("a bug"));
    await expect(board(planner, "07:58")).rejects.toThrow("a bug");
    planner.realtime = undefined;
    const answer = await board(planner, "07:58");
    expect([answer.live, answer.departures[1]!.delay]).toEqual(["off", null]);
  });
});

describe("the CLI with GOLEMIO_API_KEY", () => {
  const run = async (env: Record<string, string>, ...args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l), now: () => new Date(2026, 10, 10, 7, 58), env };
    const code = await main(["departures", "--gtfs", MINI, "--no-cache", "--stop", "alpha", "--date", "2026-11-10", "--time", "07:58", "--limit", "3", ...args], io);
    return { code, out, err };
  };

  it("prints the delays, from the key and URL in the environment", async () => {
    const { code, out, err } = await run({ GOLEMIO_API_KEY: KEY, GOLEMIO_API_URL: base });
    expect(code).toBe(0);
    expect(out).toEqual([
      "Departures from Alpha, 2026-11-10 07:58 (live)",
      "  08:00  in 2 min   tram 1   towards Charlie",
      "  08:00  in 4 min   bus 300  towards Delta, Náměstí  (platform 4J)  +2 min", // expected 08:02:30; platform from live data
      "  08:05  in 7 min   bus 300  towards Delta, Náměstí  CANCELED",
    ]);
    expect(requests[0]!.headers["x-access-token"]).toBe(KEY);
    expect([...out, ...err].join("\n")).not.toContain(KEY);
  });

  it("says when the delays aren't available, and asks nothing without a key", async () => {
    reply = () => ({ status: 401, body: "{}" });
    const failed = await run({ GOLEMIO_API_KEY: KEY, GOLEMIO_API_URL: base });
    expect(failed.out[0]).toBe("Departures from Alpha, 2026-11-10 07:58 (live delays unavailable)");
    expect(failed.err).toContain("live: no delays (the API key was refused (401)); showing the timetable");
    requests = [];
    const off = await run({ GOLEMIO_API_URL: base });
    expect(off.out[0]).toBe("Departures from Alpha, 2026-11-10 07:58");
    expect(requests).toHaveLength(0);
  });

  it("writes delays the way a board shows them", () => {
    expect([0, 59, 60, 150, -1, -60, -61].map(delayText)).toEqual(["on time", "on time", "+1 min", "+2 min", "on time", "-1 min", "-1 min"]);
  });
});

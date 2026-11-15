/**
 * The next departures from a stop (Planner.departures, GET /api/departures, the CLI), on the
 * test feed. Weekday trips on Tuesday 10 Nov 2026:
 *
 * - Alpha: tram 1 at 08:00 and 08:10 (vehicle not step-free) to Charlie, bus 300 at 08:00
 *   (slow) and 08:05 (express, step-free) to Delta, metro 11 at 09:00, night bus 905 at 23:55.
 * - Charlie: tram 1 ends there (an arrival, not a departure); tram 9 starts there (08:20,
 *   08:23); bus 300 passes on to Delta (08:18, 08:20); night bus 905 from Monday passes at
 *   24:10 = 00:10.
 * - Bravo: tram 1 from platform 1, bus 200 from platform 2; tram 8 stops at platform 1 at 08:01
 *   only to let people off (pickup_type 1).
 */
import { appendFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { createAppServer } from "../src/server.js";
import { Planner, RequestError } from "../src/service.js";

const MINI = join(import.meta.dirname, "fixtures", "mini");
const planner = new Planner(MINI, () => new Date(2026, 10, 10, 7, 58));
const TUESDAY = "2026-11-10";

const board = async (stop: string, time: string, more: { limit?: number; window?: number } = {}) =>
  (await planner.departures({ stop, date: TUESDAY, time, ...more })).departures.map((d) => [d.departure, d.minutes, `${d.mode} ${d.line}`, d.headsign]);

describe("departures", () => {
  it("lists the next departures from every platform of a stop, in time order", async () => {
    const answer = await planner.departures({ stop: "alpha", date: TUESDAY, time: "07:58", limit: 5 });
    expect([answer.stop, answer.date, answer.time]).toEqual(["Alpha", TUESDAY, "07:58"]);
    expect(answer.departures.map((d) => [d.departure, d.minutes, d.line, d.headsign, d.access])).toEqual([
      ["08:00", 2, "1", "Charlie", "no"], // same minute: by line
      ["08:00", 2, "300", "Delta, Náměstí", "unknown"],
      ["08:05", 7, "300", "Delta, Náměstí", "yes"],
      ["08:10", 12, "1", "Charlie", "no"],
      ["09:00", 62, "11", "Gamma", "unknown"],
    ]);
    expect(answer.departures[4]).toMatchObject({ mode: "metro", color: "00A562", textColor: "FFFFFF" });
    expect(answer.feed).toMatchObject({ firstDate: "2026-11-02", lastDate: "2026-11-30" });
  });

  it("leaves out trips that end at the stop", async () => {
    // Tram 1 arrives at Charlie at 08:10 and 08:20 and goes no further.
    expect(await board("charlie", "08:00", { window: 30 })).toEqual([
      ["08:18", 18, "bus 300", "Delta, Náměstí"],
      ["08:20", 20, "bus 300", "Delta, Náměstí"],
      ["08:20", 20, "tram 9", "Foxtrot North"],
      ["08:23", 23, "tram 9", "Foxtrot North"],
    ]);
  });

  it("starts at the time asked, keeps to the window and the limit", async () => {
    expect(await board("alpha", "08:05", { window: 5 })).toEqual([
      ["08:05", 0, "bus 300", "Delta, Náměstí"],
      ["08:10", 5, "tram 1", "Charlie"],
    ]);
    expect(await board("alpha", "07:58", { limit: 2 })).toHaveLength(2);
    expect(await board("alpha", "09:01", { window: 60 })).toEqual([]);
  });

  it("includes the previous day's trips after midnight, and today's past midnight", async () => {
    expect(await board("charlie", "00:00", { window: 30 })).toEqual([["00:10", 10, "bus 905", "Delta, Náměstí"]]);
    expect(await board("charlie", "23:50", { window: 30 })).toEqual([["00:10 (+1)", 20, "bus 905", "Delta, Náměstí"]]);
  });

  it("refuses a bad limit or window, and an unknown stop with names to pick from", async () => {
    await expect(planner.departures({ stop: "alpha", limit: 0 })).rejects.toThrow("limit must be a whole number from 1 to 100");
    await expect(planner.departures({ stop: "alpha", window: 1441 })).rejects.toThrow(/^window must be/);
    const error = await planner.departures({ stop: "foxtrot", date: TUESDAY }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RequestError);
    expect((error as RequestError).suggestions).toEqual(["Foxtrot North", "Foxtrot South"]);
  });

  it("leaves out a stop where the vehicle only lets people off, and says the platform", async () => {
    const answer = await planner.departures({ stop: "bravo", date: TUESDAY, time: "08:00", window: 15 });
    // Not step-free: tram 1 for its vehicle, bus 200 for its stop (Bravo's platforms inherit
    // the station's "no").
    expect(answer.departures.map((d) => [d.departure, `${d.mode} ${d.line}`, d.platform, d.access])).toEqual([
      ["08:05", "tram 1", "1", "no"],
      ["08:08", "bus 200", "2", "no"],
      ["08:15", "tram 1", "1", "no"],
    ]);
  });

  it("counts minutes the way a clock shows them", async () => {
    // Metro 12 leaves Gamma (2) at 09:12:30: at 09:10 that is "09:12", in 2 min (not 2.5 -> 3).
    expect(await board("gamma", "09:10", { window: 5 })).toEqual([["09:12", 2, "metro 12", "Echo"]]);
  });

  describe("a stop the vehicle only drives past", () => {
    const dir = mkdtempSync(join(tmpdir(), "transit-raptor-departures-"));
    cpSync(MINI, dir, { recursive: true });
    // Bus 300 (express) passes Bravo (1) at 08:10 without stopping; tram 1 stops there.
    appendFileSync(join(dir, "stop_times.txt"), "L3express,08:10:00,08:10:00,B1,15,1,1,\n");
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("isn't a departure", async () => {
      const answer = await new Planner(dir, () => new Date(2026, 10, 10, 8, 0)).departures({ stop: "bravo", date: TUESDAY, time: "08:00", window: 15 });
      expect(answer.departures.map((d) => [d.departure, d.line, d.platform])).toEqual([
        ["08:05", "1", "1"],
        ["08:08", "200", "2"],
        ["08:15", "1", "1"],
      ]);
    });
  });
});

describe("GET /api/departures", () => {
  const server = createAppServer(planner);
  let base = "";
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("answers with the departures, and 400 for a bad stop or number", async () => {
    const ok = await fetch(`${base}/api/departures?stop=alpha&date=${TUESDAY}&time=07:58&limit=1`);
    expect(ok.status).toBe(200);
    expect((await ok.json()).departures).toEqual([
      expect.objectContaining({ departure: "08:00", minutes: 2, mode: "tram", line: "1", headsign: "Charlie", platform: "" }),
    ]);
    const unknown = await fetch(`${base}/api/departures?stop=foxtrot&date=${TUESDAY}`);
    expect([unknown.status, await unknown.json()]).toEqual([
      400,
      { error: 'stop: "foxtrot" matches several stops', suggestions: ["Foxtrot North", "Foxtrot South"] },
    ]);
    expect((await fetch(`${base}/api/departures?stop=alpha&limit=many`)).status).toBe(400);
  });

  it("serves the board page and its script", async () => {
    const page = await fetch(`${base}/departures`);
    expect([page.status, page.headers.get("content-type")]).toEqual([200, "text/html; charset=utf-8"]);
    expect(await page.text()).toContain('<script src="/departures.js" type="module">');
    expect((await fetch(`${base}/departures.js`)).headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  });
});

describe("transit-raptor departures", () => {
  const run = async (...args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l), now: () => new Date(2026, 10, 10, 7, 58) };
    const code = await main(["departures", "--gtfs", MINI, "--no-cache", ...args], io);
    return { code, out, err };
  };

  it("prints the board", async () => {
    expect(await run("--stop", "alpha", "--date", TUESDAY, "--time", "08:00", "--limit", "3")).toMatchObject({
      code: 0,
      out: [
        "Departures from Alpha, 2026-11-10 08:00",
        "  08:00  now        tram 1   towards Charlie",
        "  08:00  now        bus 300  towards Delta, Náměstí",
        "  08:05  in 5 min   bus 300  towards Delta, Náměstí",
      ],
    });
  });

  it("says when nothing leaves, and refuses bad input", async () => {
    expect(await run("--stop", "delta", "--date", TUESDAY, "--time", "08:00")).toMatchObject({
      code: 1,
      out: ["No departures from Delta, Náměstí after 08:00 on 2026-11-10."],
    });
    expect((await run()).err[0]).toBe("transit-raptor: --stop is required");
    expect((await run("--stop", "foxtrot")).err[0]).toBe(
      'transit-raptor: --stop: "foxtrot" matches several stops (did you mean: Foxtrot North, Foxtrot South?)',
    );
    expect((await run("--stop", "alpha", "--limit", "-1")).code).toBe(2);
    expect((await run("--stop", "alpha", "--window", "2h")).err[0]).toBe(
      "transit-raptor: --window must be a whole number of minutes from 1 to 1440",
    );
  });
});

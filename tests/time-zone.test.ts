/**
 * The feed's time zone (agency.txt's agency_timezone): "today", "now" and the instants sent to
 * Golemio are taken in it, whatever zone the machine is in, and a service day starts at "noon
 * minus 12 hours", which on the two daylight-saving days is not midnight.
 *
 * Every clock here is a UTC instant (Date.UTC), so the tests mean the same on any machine.
 */
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openFeed } from "../src/cache.js";
import { main } from "../src/cli.js";
import { readTimeZone } from "../src/gtfs.js";
import type { LiveDeparture, LiveQuery, Realtime } from "../src/realtime.js";
import { Planner } from "../src/service.js";
import {
  dateIn,
  formatDate,
  instantOf,
  isTimeZone,
  localZone,
  parseDate,
  serviceDayStart,
  serviceSeconds,
  wallClock,
  zoneOffset,
} from "../src/time.js";

const MINI = join(import.meta.dirname, "fixtures", "mini");
const PRAGUE = "Europe/Prague";
const iso = (ms: number) => new Date(ms).toISOString();
const utc = (...parts: [number, number, number, number?, number?]) => new Date(Date.UTC(...parts));

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A copy of the test feed with this agency.txt (or none). */
function feedWith(agency: string | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), "transit-raptor-zone-"));
  dirs.push(dir);
  cpSync(MINI, dir, { recursive: true });
  if (agency !== undefined) writeFileSync(join(dir, "agency.txt"), agency);
  return dir;
}

const AGENCY = (zone: string) => `agency_id,agency_name,agency_url,agency_timezone\n99,PID,https://pid.cz,${zone}\n`;

describe("service days in a time zone", () => {
  it("start at midnight on an ordinary day", () => {
    expect(iso(serviceDayStart(parseDate("2026-11-10"), PRAGUE))).toBe("2026-11-09T23:00:00.000Z"); // CET, +1
    expect(iso(serviceDayStart(parseDate("2026-07-01"), PRAGUE))).toBe("2026-06-30T22:00:00.000Z"); // CEST, +2
    expect(iso(serviceDayStart(parseDate("2026-11-10"), "America/New_York"))).toBe("2026-11-10T05:00:00.000Z");
    expect(iso(serviceDayStart(parseDate("2026-11-10"), "UTC"))).toBe("2026-11-10T00:00:00.000Z");
  });

  it("start at 23:00 the evening before when the clocks go forward", () => {
    // 29 Mar 2026: 02:00 CET -> 03:00 CEST. Noon is 10:00 UTC, so 00:00:00 is 22:00 UTC the day
    // before: 23:00 by the clock.
    const start = serviceDayStart(parseDate("2026-03-29"), PRAGUE);
    expect(iso(start)).toBe("2026-03-28T22:00:00.000Z");
    expect(wallClock(parseDate("2026-03-29"), 0, PRAGUE)).toBe("2026-03-28T23:00:00");
    expect(wallClock(parseDate("2026-03-29"), 3600, PRAGUE)).toBe("2026-03-29T00:00:00");
    // After the change the timetable and the clock agree again.
    expect(wallClock(parseDate("2026-03-29"), 3 * 3600, PRAGUE)).toBe("2026-03-29T03:00:00");
    expect(wallClock(parseDate("2026-03-29"), 8 * 3600 + 5 * 60, PRAGUE)).toBe("2026-03-29T08:05:00");
  });

  it("start at 01:00 when the clocks go back", () => {
    // 25 Oct 2026: 03:00 CEST -> 02:00 CET. Noon is 11:00 UTC, so 00:00:00 is 23:00 UTC the day
    // before: 01:00 by the clock.
    expect(iso(serviceDayStart(parseDate("2026-10-25"), PRAGUE))).toBe("2026-10-24T23:00:00.000Z");
    expect(wallClock(parseDate("2026-10-25"), 0, PRAGUE)).toBe("2026-10-25T01:00:00");
    expect(wallClock(parseDate("2026-10-25"), 3 * 3600, PRAGUE)).toBe("2026-10-25T03:00:00");
    // The New York change (1 Nov 2026) the same way, at -4 -> -5.
    expect(iso(serviceDayStart(parseDate("2026-11-01"), "America/New_York"))).toBe("2026-11-01T05:00:00.000Z");
  });

  it("go past 24:00 into the next date", () => {
    expect(wallClock(parseDate("2026-11-10"), 24 * 3600 + 20 * 60, PRAGUE)).toBe("2026-11-11T00:20:00");
    expect(wallClock(parseDate("2026-12-31"), 25 * 3600, PRAGUE)).toBe("2027-01-01T01:00:00");
    expect(iso(instantOf(parseDate("2026-11-10"), 24 * 3600 + 10 * 60, PRAGUE).getTime())).toBe("2026-11-10T23:10:00.000Z");
  });

  it("turn instants into seconds of a day, and back", () => {
    const date = parseDate("2026-11-10");
    expect(serviceSeconds(utc(2026, 10, 10, 6, 58), date, PRAGUE)).toBe(7 * 3600 + 58 * 60);
    expect(serviceSeconds(utc(2026, 10, 10, 23, 5), date, PRAGUE)).toBe(24 * 3600 + 5 * 60);
    expect(serviceSeconds(utc(2026, 10, 9, 22, 0), date, PRAGUE)).toBe(-3600);
    // On the day the clocks go back, 02:30 CEST (00:30 UTC) is 01:30 of the timetable.
    expect(serviceSeconds(utc(2026, 9, 25, 0, 30), parseDate("2026-10-25"), PRAGUE)).toBe(90 * 60);
    for (const seconds of [0, 1, 3599, 7 * 3600, 26 * 3600]) {
      expect(serviceSeconds(instantOf(date, seconds, PRAGUE), date, PRAGUE)).toBe(seconds);
    }
  });

  it("give the date the zone's clocks show", () => {
    const lateEvening = utc(2026, 10, 10, 23, 30);
    expect(formatDate(dateIn(lateEvening, PRAGUE))).toBe("2026-11-11");
    expect(formatDate(dateIn(lateEvening, "UTC"))).toBe("2026-11-10");
    expect(formatDate(dateIn(utc(2026, 10, 10, 3, 0), "America/Los_Angeles"))).toBe("2026-11-09");
  });

  it("know the offsets", () => {
    expect(zoneOffset(Date.UTC(2026, 10, 10, 12), PRAGUE)).toBe(3600);
    expect(zoneOffset(Date.UTC(2026, 6, 1, 12), PRAGUE)).toBe(7200);
    expect(zoneOffset(Date.UTC(2026, 6, 1, 12), "Asia/Kolkata")).toBe(5.5 * 3600);
    expect(zoneOffset(Date.UTC(2026, 6, 1, 12, 0, 0) + 999, "UTC")).toBe(0); // milliseconds ignored
  });

  it("only take zone names the runtime knows", () => {
    expect(isTimeZone(PRAGUE)).toBe(true);
    expect(isTimeZone("UTC")).toBe(true);
    expect(isTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isTimeZone("")).toBe(false);
    expect(isTimeZone("  ")).toBe(false);
    expect(isTimeZone(localZone())).toBe(true);
  });
});

describe("agency.txt", () => {
  it("gives the feed's zone", async () => {
    expect(await readTimeZone(feedWith(AGENCY(PRAGUE)))).toBe(PRAGUE);
  });

  it("is optional, and a zone the runtime doesn't know is skipped for the next one", async () => {
    expect(await readTimeZone(feedWith(undefined))).toBeNull();
    expect(await readTimeZone(feedWith("agency_id,agency_name\n1,X\n"))).toBeNull();
    expect(await readTimeZone(feedWith(`agency_id,agency_timezone\n1,Nowhere/Land\n2, ${PRAGUE} \n3,UTC\n`))).toBe(PRAGUE);
  });

  it("is kept in the cache", async () => {
    const dir = feedWith(AGENCY("America/New_York"));
    const cacheDir = join(dir, ".cache");
    expect((await openFeed(dir, { cacheDir })).compiled.timeZone).toBe("America/New_York");
    const cached = await openFeed(dir, { cacheDir });
    expect([cached.source, cached.compiled.timeZone]).toEqual(["cache", "America/New_York"]);
  });
});

/** A source that answers nothing and remembers what it was asked. */
class FakeRealtime implements Realtime {
  asked: LiveQuery[] = [];
  departures(query: LiveQuery) {
    this.asked.push(query);
    return Promise.resolve(new Map<string, LiveDeparture>());
  }
}

describe("a planner on a machine in another zone", () => {
  const prague = feedWith(AGENCY(PRAGUE));

  it("plans for today and now in the feed's zone", async () => {
    // 06:58 UTC is 07:58 in Prague, whatever zone this machine is in.
    const planner = new Planner(prague, () => utc(2026, 10, 10, 6, 58));
    const answer = await planner.plan({ from: "Alpha", to: "Delta", window: 0 });
    expect([answer.date, answer.time, answer.feed.timeZone]).toEqual(["2026-11-10", "07:58", PRAGUE]);
    expect(answer.journeys.map((j) => j.departure)).toEqual(["08:05", "08:00"]);
  });

  it("is already on tomorrow's date at 00:30 in Prague (23:30 UTC)", async () => {
    const planner = new Planner(prague, () => utc(2026, 10, 10, 23, 30));
    const board = await planner.departures({ stop: "Alpha" });
    expect([board.date, board.time]).toEqual(["2026-11-11", "00:30"]);
    expect(await planner.zone()).toBe(PRAGUE);
  });

  it("takes now in the timetable's terms on the day the clocks go back", async () => {
    // 02:30 CEST, before the change: 01:30 of the timetable (whose 00:00 was 01:00 by the clock).
    const planner = new Planner(prague, () => utc(2026, 9, 25, 0, 30));
    const answer = await planner.departures({ stop: "Alpha" });
    expect([answer.date, answer.time]).toEqual(["2026-10-25", "01:30"]);
  });

  it("asks Golemio for the right date after midnight (a board at 24:05 is 00:05 the next day)", async () => {
    const planner = new Planner(prague, () => utc(2026, 10, 10, 23, 5)); // 00:05 on the 11th in Prague
    const fake = new FakeRealtime();
    planner.realtime = fake;
    const board = await planner.departures({ stop: "Charlie", date: "2026-11-10", time: "24:05", limit: 3 });
    expect(board.live).toBe("on");
    expect(board.departures.map((d) => d.departure)).toEqual(["00:10 (+1)"]);
    expect(fake.asked.map((q) => q.from)).toEqual(["2026-11-11T00:05:00"]);
  });

  it("asks about the journeys of now, measured on the feed's clock", async () => {
    const planner = new Planner(prague, () => utc(2026, 10, 10, 6, 58));
    const fake = new FakeRealtime();
    planner.realtime = fake;
    const answer = await planner.plan({ from: "Alpha", to: "Delta", date: "2026-11-10", time: "08:00", window: 0 });
    expect(answer.live).toBe("on");
    expect(fake.asked.map((q) => q.from)).toEqual(["2026-11-10T07:58:00"]);
    // An hour later by UTC in another zone's terms would be a board for another time: off.
    const elsewhere = new Planner(feedWith(AGENCY("Europe/London")), () => utc(2026, 10, 10, 6, 58));
    elsewhere.realtime = new FakeRealtime();
    expect((await elsewhere.departures({ stop: "Alpha", date: "2026-11-10", time: "08:30" })).live).toBe("off");
  });

  it("falls back to this machine's zone for a feed without agency.txt", async () => {
    const planner = new Planner(MINI, () => new Date(2026, 10, 10, 7, 58));
    const answer = await planner.departures({ stop: "Alpha" });
    expect([answer.date, answer.time, answer.feed.timeZone]).toEqual(["2026-11-10", "07:58", localZone()]);
  });

  it("checks a bad date before opening the feed", async () => {
    const planner = new Planner(join(MINI, "missing"));
    await expect(planner.plan({ from: "Alpha", to: "Delta", date: "2026-02-30" })).rejects.toThrow(/no such date/);
  });
});

describe("the command line", () => {
  it("plans for now in the feed's zone", async () => {
    const out: string[] = [];
    const io = { out: (l: string) => out.push(l), err: () => {}, now: () => utc(2026, 10, 10, 23, 40) };
    // 23:40 UTC is 00:40 on 11 Nov in Prague: the first bus is that morning's.
    expect(await main(["plan", "--gtfs", prague(), "--from", "Alpha", "--to", "Delta", "--window", "0"], io)).toBe(0);
    expect(out[0]).toBe("Alpha -> Delta, Náměstí, 2026-11-11");
    expect(out.join("\n")).toMatch(/08:00/);
  });
});

function prague(): string {
  return feedWith(AGENCY(PRAGUE));
}

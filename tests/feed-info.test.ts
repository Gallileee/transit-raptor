/**
 * Which timetable is in use: the dates it covers and when it was loaded (GET /api/feed and the
 * `feed` of every plan answer), so the page can say so.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openFeed } from "../src/cache.js";
import { main } from "../src/cli.js";
import { coverageNote } from "../src/format.js";
import { type Calendar, type CalendarEntry, coveredDates, readCalendar, serviceRange } from "../src/gtfs.js";
import { createAppServer } from "../src/server.js";
import { Planner } from "../src/service.js";
import { formatDate, parseDate } from "../src/time.js";

const MINI = join(import.meta.dirname, "fixtures", "mini");

const WEEKDAYS = [true, true, true, true, true, false, false];
const entry = (start: number, end: number, days = WEEKDAYS): CalendarEntry => ({ serviceId: "S", days, start, end });
const range = (calendar: Calendar) => {
  const r = serviceRange(calendar);
  return r && [formatDate(r.first), formatDate(r.last)];
};

describe("serviceRange", () => {
  it("is the test feed's weekdays in November, without the Sunday its calendar starts on", async () => {
    // WK: Monday to Friday, 20261101 (a Sunday) to 20261130 (a Monday).
    expect(range(await readCalendar(MINI))).toEqual(["2026-11-02", "2026-11-30"]);
  });

  it("moves both ends in to days with service", () => {
    // 20261107 is a Saturday, 20261122 a Sunday: weekday service runs 9th to 20th.
    expect(range({ entries: [entry(20261107, 20261122)], exceptions: [] })).toEqual(["2026-11-09", "2026-11-20"]);
  });

  it("counts dates added in calendar_dates.txt, and not dates removed", () => {
    const calendar: Calendar = {
      entries: [entry(20261109, 20261120)],
      exceptions: [
        { serviceId: "S", date: 20261109, type: 2 },
        { serviceId: "X", date: 20261128, type: 1 },
      ],
    };
    expect(range(calendar)).toEqual(["2026-11-10", "2026-11-28"]);
    expect(range({ entries: [], exceptions: [{ serviceId: "X", date: 20261128, type: 1 }] })).toEqual(["2026-11-28", "2026-11-28"]);
  });

  it("is undefined when nothing ever runs", () => {
    expect(serviceRange({ entries: [], exceptions: [] })).toBeUndefined();
    expect(serviceRange({ entries: [entry(20261109, 20261120, Array(7).fill(false))], exceptions: [] })).toBeUndefined();
    const removed: Calendar = { entries: [entry(20261109, 20261109)], exceptions: [{ serviceId: "S", date: 20261109, type: 2 }] };
    expect(serviceRange(removed)).toBeUndefined();
  });
});

describe("coveredDates", () => {
  const calendar: Calendar = { entries: [entry(20251215, 20261211)], exceptions: [] };
  const covered = (start: number | null, end: number | null) => {
    const r = coveredDates({ calendar, published: { start, end } });
    return r && [formatDate(r.first), formatDate(r.last)];
  };

  it("takes feed_info.txt's dates over the calendar's (PID: trains all year, the rest two weeks)", () => {
    expect(covered(20261109, 20261122)).toEqual(["2026-11-09", "2026-11-22"]);
  });

  it("falls back to the calendar for a date feed_info.txt leaves out", () => {
    expect(covered(null, null)).toEqual(["2025-12-15", "2026-12-11"]);
    expect(covered(null, 20261122)).toEqual(["2025-12-15", "2026-11-22"]);
    expect(covered(20261109, null)).toEqual(["2026-11-09", "2026-12-11"]);
  });

  it("is undefined when the dates make no sense", () => {
    expect(covered(20261122, 20261109)).toBeUndefined();
  });
});

describe("feed_info.txt", () => {
  const dir = mkdtempSync(join(tmpdir(), "transit-raptor-feed-info-txt-"));
  cpSync(MINI, dir, { recursive: true });
  writeFileSync(
    join(dir, "feed_info.txt"),
    'feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date\n"Test","https://example.org",en,20261109,20261122\n',
  );
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("gives the dates the page shows, also when the feed comes from the cache", async () => {
    const cacheDir = join(dir, ".cache");
    expect((await openFeed(dir, { cacheDir })).source).toBe("csv");
    const cached = await openFeed(dir, { cacheDir });
    expect(cached.source).toBe("cache");
    expect(cached.compiled.published).toEqual({ start: 20261109, end: 20261122 });
    const planner = new Planner(dir, () => new Date(2026, 10, 10, 7, 58), 2, () => {}, cacheDir);
    expect(await planner.feed()).toMatchObject({ firstDate: "2026-11-09", lastDate: "2026-11-22" });
  });

  it("ignores a date that doesn't exist", async () => {
    writeFileSync(join(dir, "feed_info.txt"), "feed_start_date,feed_end_date\n20261109,20261399\n");
    const { compiled } = await openFeed(dir);
    expect(compiled.published).toEqual({ start: 20261109, end: null });
  });

  it("is read without the dates, which are optional", async () => {
    writeFileSync(join(dir, "feed_info.txt"), "feed_publisher_name,feed_publisher_url,feed_lang\nTest,https://example.org,en\n");
    const { compiled } = await openFeed(dir);
    expect(compiled.published).toEqual({ start: null, end: null });
  });
});

describe("the timetable in use", () => {
  let clock = new Date(2026, 10, 10, 7, 58);
  const planner = new Planner(MINI, () => clock);

  it("says which dates it covers and when it was loaded", async () => {
    expect(await planner.feed()).toEqual({ firstDate: "2026-11-02", lastDate: "2026-11-30", loadedAt: clock.toISOString() });
  });

  it("comes with every plan answer, and keeps its load time", async () => {
    const loadedAt = clock.toISOString();
    clock = new Date(2026, 10, 10, 9, 0);
    const answer = await planner.plan({ from: "Alpha", to: "Delta", date: "2026-11-11", time: "08:00" });
    expect(answer.feed).toEqual({ firstDate: "2026-11-02", lastDate: "2026-11-30", loadedAt });
  });

  describe("after a new download", () => {
    const dir = mkdtempSync(join(tmpdir(), "transit-raptor-feed-info-"));
    cpSync(MINI, dir, { recursive: true });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("is the new one", async () => {
      let now = new Date(2026, 10, 10, 7, 58);
      const reloading = new Planner(dir, () => now);
      await reloading.plan({ from: "Alpha", to: "Delta", date: "2026-11-10", time: "08:00" });
      // The next download runs a week longer.
      const calendar = join(dir, "calendar.txt");
      writeFileSync(calendar, readFileSync(calendar, "utf8").replace("20261130", "20261207"));
      utimesSync(calendar, new Date(2030, 0, 1), new Date(2030, 0, 1));
      now = new Date(2026, 10, 10, 12, 0);
      expect(await reloading.checkForNewFeed()).toBe("waiting");
      expect(await reloading.checkForNewFeed()).toBe("reloaded");
      const fresh = { firstDate: "2026-11-02", lastDate: "2026-12-07", loadedAt: now.toISOString() };
      expect(await reloading.feed()).toEqual(fresh);
      expect((await reloading.plan({ from: "Alpha", to: "Delta", date: "2026-11-10", time: "08:00" })).feed).toEqual(fresh);
    });
  });
});

describe("GET /api/feed", () => {
  const server = createAppServer(new Planner(MINI, () => new Date(Date.UTC(2026, 10, 10, 6, 58))));
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("answers with the timetable in use", async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/feed`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ firstDate: "2026-11-02", lastDate: "2026-11-30", loadedAt: "2026-11-10T06:58:00.000Z" });
  });
});

describe("a date outside the timetable", () => {
  const published = { start: 20261109, end: 20261122 };
  const calendar: Calendar = { entries: [entry(20251215, 20261211)], exceptions: [] };

  it("gets a note saying a better journey may be missing", () => {
    expect(coverageNote({ calendar, published }, parseDate("2026-11-25"))).toBe(
      "Note: 2026-11-25 is after the timetable's last date, 2026-11-22: only lines whose timetables reach that day are included, so a better journey may be missing.",
    );
    expect(coverageNote({ calendar, published }, parseDate("2026-11-06"))).toMatch(
      /^Note: 2026-11-06 is before the timetable's first date, 2026-11-09: /,
    );
  });

  it("gets no note inside it, on its first and last date, or when the feed gives no dates", () => {
    for (const date of ["2026-11-09", "2026-11-15", "2026-11-22"]) {
      expect(coverageNote({ calendar, published }, parseDate(date))).toBeUndefined();
    }
    const nothing: Calendar = { entries: [], exceptions: [] };
    expect(coverageNote({ calendar: nothing, published: { start: null, end: null } }, parseDate("2026-11-25"))).toBeUndefined();
  });

  describe("in the CLI", () => {
    const dir = mkdtempSync(join(tmpdir(), "transit-raptor-outside-"));
    cpSync(MINI, dir, { recursive: true });
    // The timetable ends on 30 Nov, but the holiday bus is published for 2 Dec too.
    writeFileSync(join(dir, "feed_info.txt"), "feed_start_date,feed_end_date\n20261102,20261130\n");
    writeFileSync(join(dir, "calendar_dates.txt"), `${readFileSync(join(MINI, "calendar_dates.txt"), "utf8")}EXTRA,20261202,1\n`);
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    const run = async (date: string) => {
      const out: string[] = [];
      const err: string[] = [];
      const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l), now: () => new Date(2026, 10, 10) };
      const args = ["plan", "--gtfs", dir, "--from", "alpha", "--to", "delta", "--date", date, "--time", "08:50", "--no-cache"];
      return { code: await main(args, io), out: out.join("\n"), notes: err.filter((l) => l.startsWith("Note:")) };
    };

    it("plans the journeys there are, with the note", async () => {
      const { code, out, notes } = await run("2026-12-02");
      expect(code).toBe(0);
      expect(out).toContain("09:00 -> 09:40");
      expect(notes).toEqual([expect.stringMatching(/^Note: 2026-12-02 is after the timetable's last date, 2026-11-30: /)]);
    });

    it("says it also when nothing runs, and not inside the timetable", async () => {
      expect((await run("2026-12-03")).notes).toHaveLength(1);
      expect((await run("2026-11-10")).notes).toEqual([]);
    });
  });
});

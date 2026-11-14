/**
 * Replacing the feed of a running planner when its files change (a new download).
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { Planner } from "../src/service.js";

const MINI = join(import.meta.dirname, "fixtures", "mini");
let dir: string;
let lines: string[];
let planner: Planner;
let tick = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "transit-raptor-reload-"));
  cpSync(MINI, dir, { recursive: true });
  lines = [];
  planner = new Planner(dir, () => new Date(2026, 10, 10, 7, 58), 2, (l) => lines.push(l));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Change a file the way a download does: new content, new modification time. */
function rewrite(file: string, change: (text: string) => string) {
  const path = join(dir, file);
  writeFileSync(path, change(readFileSync(path, "utf8")));
  const time = new Date(2030, 0, 1, 0, 0, ++tick);
  utimesSync(path, time, time);
}

const busLeaves = async () => {
  const response = await planner.plan({ from: "Alpha", to: "Delta", date: "2026-11-10", time: "08:00", window: 0 });
  return response.journeys.map((j) => j.departure);
};

describe("checkForNewFeed", () => {
  it("does nothing while the files are unchanged, or before anything was loaded", async () => {
    expect(await planner.checkForNewFeed()).toBe("unchanged");
    await busLeaves();
    expect(await planner.checkForNewFeed()).toBe("unchanged");
    expect(lines).toEqual([]);
  });

  it("waits for the files to stop changing, then swaps the new feed in", async () => {
    expect(await busLeaves()).toEqual(["08:05", "08:00"]);
    // The express bus leaves Alpha at 08:07 instead of 08:05 in the new timetable.
    rewrite("stop_times.txt", (t) => t.replace("L3express,08:05:00,08:05:00", "L3express,08:07:00,08:07:00"));
    expect(await planner.checkForNewFeed()).toBe("waiting");
    expect(await busLeaves()).toEqual(["08:05", "08:00"]); // still the feed in use
    expect(await planner.checkForNewFeed()).toBe("reloaded");
    expect(await busLeaves()).toEqual(["08:07", "08:00"]);
    expect(lines).toEqual([
      "feed: files changed; loading them once they stop changing",
      expect.stringMatching(/^feed: reloaded in \d+ ms$/),
    ]);
    expect(await planner.checkForNewFeed()).toBe("unchanged");
  });

  it("starts waiting again when the files are still changing", async () => {
    await busLeaves();
    rewrite("trips.txt", (t) => t);
    expect(await planner.checkForNewFeed()).toBe("waiting");
    rewrite("stop_times.txt", (t) => t); // the download goes on
    expect(await planner.checkForNewFeed()).toBe("waiting");
    expect(await planner.checkForNewFeed()).toBe("reloaded");
  });

  it("keeps the feed in use when the new files can't be read, until they change again", async () => {
    await busLeaves();
    rewrite("stops.txt", (t) => t.replace("stop_id,", "id,")); // stop_times now refers to unknown stops
    rewrite("stop_times.txt", (t) => t);
    expect(await planner.checkForNewFeed()).toBe("waiting");
    expect(await planner.checkForNewFeed()).toBe("failed");
    expect(lines.at(-1)).toMatch(/^feed: not reloaded \(.+\); still using the previous one$/);
    expect(await busLeaves()).toEqual(["08:05", "08:00"]);
    expect(await planner.checkForNewFeed()).toBe("failed"); // not read again and again
    expect(lines.filter((l) => l.startsWith("feed: not reloaded"))).toHaveLength(1);

    rewrite("stops.txt", (t) => t.replace("id,", "stop_id,")); // fixed by the next download
    expect(await planner.checkForNewFeed()).toBe("waiting");
    expect(await planner.checkForNewFeed()).toBe("reloaded");
  });

  it("answers requests during a reload from the feed in use", async () => {
    await busLeaves();
    rewrite("stop_times.txt", (t) => t.replace("L3express,08:05:00,08:05:00", "L3express,08:07:00,08:07:00"));
    await planner.checkForNewFeed();
    const reload = planner.checkForNewFeed();
    expect(await planner.checkForNewFeed()).toBe("busy");
    const during = busLeaves();
    expect(await reload).toBe("reloaded");
    expect(await during).toEqual(["08:05", "08:00"]);
    expect(await busLeaves()).toEqual(["08:07", "08:00"]);
  });

  it("forgets the timetables of other dates, which came from the old feed", async () => {
    const other = { year: 2026, month: 11, day: 11 };
    const before = await planner.load(other);
    rewrite("trips.txt", (t) => t);
    await planner.checkForNewFeed();
    await planner.checkForNewFeed();
    expect(await planner.load(other)).not.toBe(before);
  });
});

describe("serve --reload", () => {
  it("must be a whole number of minutes", async () => {
    const err: string[] = [];
    const io = { out: () => {}, err: (l: string) => err.push(l), now: () => new Date() };
    for (const bad of ["-1", "1.5", "soon", "1441"]) {
      expect(await main(["serve", "--gtfs", MINI, "--no-cache", `--reload=${bad}`], io)).toBe(2);
    }
    expect(err.filter((l) => l.startsWith("transit-raptor: --reload"))).toHaveLength(4);
  });
});

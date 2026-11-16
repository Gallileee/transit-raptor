/**
 * Times for stops the feed gives none (src/gtfs.ts interpolateTimes): between the timed stops
 * around them, by the distance travelled.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileFeed, interpolateTimes } from "../src/gtfs.js";

// Stops on a line north from 50.00 N, 14.00 E: 0.01 degrees of latitude is about 1,112 m.
const stops = [0, 0.01, 0.02, 0.03, 0.04, 0.1].map((d) => ({ lat: 50 + d, lon: 14 }));

/** One trip over `at` (stop indices), with times in seconds (-1: none) and distances. */
function fill(times: number[], at: number[], distances: number[] = times.map(() => NaN)) {
  const columns = {
    arrivals: Int32Array.from(times),
    departures: Int32Array.from(times),
    stops: Int32Array.from(at),
    distances: Float32Array.from(distances),
  };
  interpolateTimes(columns, 0, times.length, stops);
  expect([...columns.departures]).toEqual([...columns.arrivals]);
  return [...columns.arrivals];
}

describe("interpolateTimes", () => {
  it("leaves timed stops as they are", () => {
    expect(fill([100, 200, 300], [0, 1, 2])).toEqual([100, 200, 300]);
  });

  it("shares the time by straight-line distance when there are no shape distances", () => {
    // 1, 1 and 2 hundredths of a degree: a quarter, a half, then the rest.
    expect(fill([0, -1, -1, 400], [0, 1, 2, 4])).toEqual([0, 100, 200, 400]);
  });

  it("uses shape_dist_traveled when every stop of the stretch has it", () => {
    // The shape says the second stop is 900 of 1,000 m along (a detour), not a quarter.
    expect(fill([0, -1, 600], [0, 1, 4], [0, 900, 1000])).toEqual([0, 540, 600]);
    // Counted from the stop before the stretch, wherever the shape starts.
    expect(fill([0, 60, -1, 600], [0, 0, 1, 4], [0, 100, 1000, 1100])).toEqual([0, 60, 546, 600]); // 60 + 0.9 x 540
    // Missing at one stop, or going back: straight lines instead.
    expect(fill([0, -1, 400], [0, 1, 4], [0, NaN, 1000])).toEqual([0, 100, 400]);
    expect(fill([0, -1, 400], [0, 1, 4], [500, 900, 100])).toEqual([0, 100, 400]);
  });

  it("fills each stretch between timed stops on its own", () => {
    expect(fill([0, -1, 200, -1, 400], [0, 1, 2, 3, 4])).toEqual([0, 100, 200, 300, 400]);
  });

  it("takes equal steps when the stops are all in one place", () => {
    expect(fill([0, -1, -1, 300], [2, 2, 2, 2])).toEqual([0, 100, 200, 300]);
  });

  it("rounds to whole seconds", () => {
    // 1 and 2 of 3 hundredths along 100 s: 33.3 and 66.7 s.
    expect(fill([0, -1, 100], [0, 1, 3])).toEqual([0, 33, 100]);
    expect(fill([0, -1, 100], [0, 2, 3])).toEqual([0, 67, 100]);
  });

  it("gives stops after the last timed one its departure, and so a time that goes back", () => {
    expect(fill([0, 100, -1, -1], [0, 1, 2, 3])).toEqual([0, 100, 100, 100]);
    expect(fill([0, 500, -1, 300], [0, 1, 2, 4])).toEqual([0, 500, 500, 300]);
  });

  it("starts from the departure of the stop before, which may be later than its arrival", () => {
    const columns = {
      arrivals: Int32Array.from([0, 100, -1, 400]),
      departures: Int32Array.from([0, 200, -1, 400]), // waits at the second stop until 200
      stops: Int32Array.from([0, 1, 2, 3]),
      distances: new Float32Array(4).fill(NaN),
    };
    interpolateTimes(columns, 0, 4, stops);
    expect([...columns.arrivals]).toEqual([0, 100, 300, 400]);
  });

  it("only touches the trip's own stop times", () => {
    const columns = {
      arrivals: Int32Array.from([-1, 0, -1, 200, -1]),
      departures: Int32Array.from([-1, 0, -1, 200, -1]),
      stops: Int32Array.from([0, 0, 1, 2, 3]),
      distances: new Float32Array(5).fill(NaN),
    };
    interpolateTimes(columns, 1, 4, stops);
    expect([...columns.arrivals]).toEqual([-1, 0, 100, 200, -1]);
  });
});

describe("a trip whose first stop has no time", () => {
  const MINI = join(import.meta.dirname, "fixtures", "mini");
  const dir = mkdtempSync(join(tmpdir(), "transit-raptor-untimed-"));
  cpSync(MINI, dir, { recursive: true });
  // Tram 1 (L1a) without its first time: there is nothing to count from.
  const lines = readFileSync(join(MINI, "stop_times.txt"), "utf8").replace("L1a,08:00:00,08:00:00,A,", "L1a,,,A,");
  writeFileSync(join(dir, "stop_times.txt"), lines);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("is an error of that trip, and the others are read as before", async () => {
    const compiled = await compileFeed(dir);
    const trip = (id: string) => compiled.trips.find((t) => t.id === id)!;
    expect(trip("L1a").error).toBe("trip L1a: the first stop has no time");
    expect([trip("L1b").error, trip("L9a").error]).toEqual(["", ""]);
  });
});

/**
 * Cutting a trip's shape between two stops, and the shapes reaching the API.
 */
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadFeed } from "../src/gtfs.js";
import { Planner } from "../src/service.js";
import { cut, positionAtDistance, project, Shapes } from "../src/shapes.js";

const MINI = join(import.meta.dirname, "fixtures", "mini");
const DATE = { year: 2026, month: 11, day: 10 };

function shape(id: string) {
  const shapes = Shapes.of({
    measured: [
      [50.0, 14.0, 0],
      [50.005, 14.002, 0.6],
      [50.01, 14.0, 1.2],
      [50.015, 13.998, 1.8],
      [50.02, 14.0, 2.4],
    ],
    plain: [
      [50.0, 14.0],
      [50.005, 14.002],
      [50.01, 14.0],
      [50.015, 13.998],
      [50.02, 14.0],
    ],
    loop: [
      [50.0, 14.0],
      [50.01, 14.0],
      [50.01, 14.0005],
      [50.0, 14.0005],
    ],
  });
  return shapes.get(id)!;
}

const stop = (lat: number, lon: number, dist = NaN) => ({ lat, lon, dist });

describe("cut", () => {
  it("cuts by shape_dist_traveled, interpolating both ends", () => {
    expect(cut(shape("measured"), stop(50.0025, 14.001, 0.3), stop(50.0125, 13.999, 1.5))).toEqual([
      [50.0025, 14.001],
      [50.005, 14.002],
      [50.01, 14.0],
      [50.0125, 13.999],
    ]);
  });

  it("doesn't repeat a point when a stop sits exactly on one", () => {
    expect(cut(shape("measured"), stop(50.0, 14.0, 0), stop(50.01, 14.0, 1.2))).toEqual([
      [50.0, 14.0],
      [50.005, 14.002],
      [50.01, 14.0],
    ]);
  });

  it("projects the stops onto the line when there are no distances", () => {
    // The second stop is ~30 m east of the fourth segment, near its middle.
    const path = cut(shape("plain"), stop(50.0, 14.0), stop(50.0125, 13.9994))!;
    expect(path.slice(0, 3)).toEqual([
      [50.0, 14.0],
      [50.005, 14.002],
      [50.01, 14.0],
    ]);
    expect(path).toHaveLength(4);
    expect(path[3]![0]).toBeCloseTo(50.01244, 4);
    expect(path[3]![1]).toBeCloseTo(13.99903, 4);
  });

  it("places the second stop after the first on a line that comes back", () => {
    // A ride on the way back: the first stop is on the return leg. The second stop is nearer
    // to the outward leg (7 m vs 29 m), but that part of the line was passed long before.
    expect(cut(shape("loop"), stop(50.008, 14.0005), stop(50.002, 14.0001))).toEqual([
      [50.008, 14.0005],
      [50.002, 14.0005],
    ]);
    // And out then back, both stops beside the line.
    const path = cut(shape("loop"), stop(50.002, 14.0), stop(50.002, 14.0005))!;
    expect(path).toEqual([
      [50.002, 14.0],
      [50.01, 14.0],
      [50.01, 14.0005],
      [50.002, 14.0005],
    ]);
  });

  it("falls back to projecting when the distances don't fit the stops (another unit)", () => {
    // Distances in metres in stop_times, kilometres in shapes.txt: 600 is past the end.
    expect(cut(shape("measured"), stop(50.005, 14.002, 600), stop(50.01, 14.0, 1200))).toEqual([
      [50.005, 14.002],
      [50.01, 14.0],
    ]);
  });

  it("gives up when a stop is far from the line", () => {
    expect(cut(shape("plain"), stop(50.0, 14.0), stop(50.01, 14.01))).toBeUndefined(); // ~700 m away
    expect(cut(shape("plain"), stop(50.03, 14.0), stop(50.04, 14.0))).toBeUndefined();
  });

  it("gives up when the second stop comes before the first", () => {
    expect(cut(shape("measured"), stop(50.01, 14.0, 1.2), stop(50.0, 14.0, 0))).toBeUndefined();
    expect(cut(shape("plain"), stop(50.01, 14.0), stop(50.0, 14.0))).toBeUndefined();
  });
});

describe("positions", () => {
  it("finds the segment of a distance by binary search, and nothing outside the line", () => {
    const s = shape("measured");
    expect(positionAtDistance(s, 0)).toEqual({ segment: 0, t: 0 });
    expect(positionAtDistance(s, 0.9)).toEqual({ segment: 1, t: expect.closeTo(0.5, 5) });
    expect(positionAtDistance(s, 2.4)).toEqual({ segment: 3, t: expect.closeTo(1, 5) });
    expect(positionAtDistance(s, 2.5)).toBeUndefined();
    expect(positionAtDistance(s, -1)).toBeUndefined();
    expect(positionAtDistance(s, NaN)).toBeUndefined();
  });

  it("projects onto the nearest segment, not before a given place", () => {
    const s = shape("loop");
    expect(project(s, 50.002, 14.0001).segment).toBe(0);
    expect(project(s, 50.002, 14.0001, { segment: 1, t: 0 }).segment).toBe(2);
  });
});

describe("loading", () => {
  it("reads shapes.txt, sorting points by sequence and noting which have distances", async () => {
    const shapes = await Shapes.load(MINI);
    expect(shapes.size).toBe(3);
    const sh1 = shapes.get("SH1")!;
    expect([...sh1.lat]).toEqual([50_000_000, 50_005_000, 50_010_000, 50_015_000, 50_020_000]);
    expect(sh1.measured).toBe(true);
    expect(shapes.get("SH2")!.measured).toBe(false);
    expect(shapes.get("")).toBeUndefined();
    expect((await Shapes.load(join(MINI, "missing"))).size).toBe(0);
  });

  it("keeps each trip's shape_id and stop distances", async () => {
    const feed = await loadFeed(MINI, DATE);
    const l1a = feed.trips.find((t) => t.id === "L1a")!;
    expect(l1a.shapeId).toBe("SH1");
    expect([...l1a.distances]).toEqual([0, expect.closeTo(1.2, 5), expect.closeTo(2.4, 5)]);
    const l3 = feed.trips.find((t) => t.id === "L3slow")!;
    expect(l3.shapeId).toBe("");
    expect([...l3.distances].every(Number.isNaN)).toBe(true);
  });
});

describe("the API", () => {
  const planner = new Planner(MINI, () => new Date(2026, 10, 10, 7, 58));
  const rides = async (from: string, to: string, time: string) =>
    (await planner.plan({ from, to, date: "2026-11-10", time, window: 0 })).journeys.flatMap((j) =>
      j.legs.filter((l) => l.kind === "ride"),
    );

  it("draws a ride along its shape when the shape fits", async () => {
    const [ride] = await rides("Alpha", "Bravo", "08:00");
    expect(ride).toMatchObject({ line: "1", shape: true });
    expect(ride!.path).toEqual([
      [50.0, 14.0],
      [50.005, 14.002],
      [50.01, 14.0],
    ]);
  });

  it("projects stops onto a shape without distances", async () => {
    const legs = await rides("Bravo", "Delta", "08:07");
    const l2 = legs.find((l) => l.kind === "ride" && l.line === "200")!;
    expect(l2).toMatchObject({ shape: true });
    expect(l2.path).toEqual([
      [50.0101, 14.001],
      [50.02, 14.003],
      [50.03, 14.0],
    ]);
  });

  it("draws straight lines between stops when the shape is somewhere else", async () => {
    const legs = await rides("Charlie", "Foxtrot North", "08:20");
    const l9 = legs.find((l) => l.kind === "ride" && l.line === "9")!;
    expect(l9).toMatchObject({ shape: false });
    expect(l9.path[0]).toEqual([50.02, 14.0]);
    expect(l9.path[l9.path.length - 1]).toEqual([50.04, 14.0]);
  });

  it("still plans when shapes.txt is broken, and says why the lines are straight", async () => {
    const dir = mkdtempSync(join(tmpdir(), "transit-raptor-"));
    try {
      cpSync(MINI, dir, { recursive: true });
      writeFileSync(join(dir, "shapes.txt"), "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nSH1,north,14,1\n");
      const lines: string[] = [];
      const broken = new Planner(dir, () => new Date(2026, 10, 10), 2, (l) => lines.push(l));
      const response = await broken.plan({ from: "Alpha", to: "Bravo", date: "2026-11-10", time: "08:00", window: 0 });
      expect(response.journeys[0]!.legs[0]).toMatchObject({ kind: "ride", shape: false });
      expect(lines).toEqual([expect.stringMatching(/^shapes\.txt not used: shapes\.txt: bad row/)]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

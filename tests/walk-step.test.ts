/**
 * RAPTOR's walk step: one walk after each vehicle, never two in a row, even when a walk makes a
 * stop earlier that another walk of the same round starts from.
 *
 * A hand-made network (seconds after midnight):
 *
 *   O --line X: 100 -> 200--> X --walk 100 s--> Z
 *   O --line Y: 100 -> 150--> Y --walk 10 s---> X
 *
 * After round 1, X is reached sooner on foot from Y (160) than by line X (200). A walk to Z can
 * only start where a vehicle arrived: from X at 200 (line X), arriving 300. Walking O -> Y -> X
 * -> Z would be two walks in a row. Line X is scanned first, so the walk X -> Z is made before
 * the walk Y -> X improves X (the order in which the bug showed in 1 of 2,000 PID journeys:
 * two walks with the wrong times), or after (a real chain, arriving at 260).
 */
import { describe, expect, it } from "vitest";
import type { Feed } from "../src/gtfs.js";
import { type Journey, plan, profile } from "../src/raptor.js";
import type { Footpath, Pattern, Timetable } from "../src/timetable.js";

const [O, X, Y, Z] = [0, 1, 2, 3];

function pattern(index: number, routeId: string, stops: number[], times: [number, number][]): Pattern {
  return {
    index,
    routeId,
    stops: Int32Array.from(stops),
    canBoard: Uint8Array.from(stops.map(() => 1)),
    canAlight: Uint8Array.from(stops.map(() => 1)),
    trips: [{ id: `${routeId}-1`, headsign: "" } as Pattern["trips"][number]],
    times: Int32Array.from(times.flat()),
  };
}

/** `yFirst`: line Y is scanned first, so the walk Y -> X comes before the walk from X. */
function timetable(yFirst: boolean): Timetable {
  const lines: [string, number, number][] = [["X", X, 200], ["Y", Y, 150]];
  if (yFirst) lines.reverse();
  const patterns = lines.map(([id, stop, at], i) => pattern(i, id, [O, stop], [[100, 100], [at, at]]));
  const stopPatterns: { pattern: number; position: number }[][] = [[], [], [], []];
  for (const p of patterns) p.stops.forEach((stop, position) => stopPatterns[stop]!.push({ pattern: p.index, position }));
  const footpaths: Footpath[][] = [[], [{ to: Z, seconds: 100 }], [{ to: X, seconds: 10 }], []];
  const feed = { stops: [{}, {}, {}, {}] } as unknown as Feed;
  return { feed, stepFree: false, patterns, stopPatterns, footpaths };
}

const legs = (j: Journey) => j.legs.map((l) => (l.kind === "walk" ? `walk ${l.from}>${l.to} ${l.departure}-${l.arrival}` : `ride ${l.routeId} ${l.departure}-${l.arrival}`));

describe.each([
  ["line X scanned first", false],
  ["line Y scanned first", true],
])("the walk step, %s", (_, yFirst) => {
  const query = { from: [O], to: [Z], departAt: 90, maxTransfers: 2 };

  it("walks from where the vehicle arrived, once", () => {
    const [journey] = plan(timetable(yFirst), query);
    expect(legs(journey!)).toEqual(["ride X 100-200", `walk ${X}>${Z} 200-300`]);
    expect(journey!.arrival).toBe(300);
  });

  it("still lets the walk make the stop sooner, for the next vehicle", () => {
    // X is reached at 160 on foot: a journey that ends at X takes line Y and walks.
    const [journey] = plan(timetable(yFirst), { ...query, to: [X] });
    expect(legs(journey!)).toEqual(["ride Y 100-150", `walk ${Y}>${X} 150-160`]);
  });

  it("does the same over a departure window (rRAPTOR)", () => {
    const journeys = profile(timetable(yFirst), { ...query, window: 60 });
    expect(journeys.map(legs)).toEqual([["ride X 100-200", `walk ${X}>${Z} 200-300`]]);
  });

  it("never puts two walks in a row", () => {
    for (const to of [[X], [Y], [Z]]) {
      for (const journey of plan(timetable(yFirst), { ...query, to })) {
        journey.legs.forEach((leg, i) => {
          if (i > 0) expect([leg.kind, journey.legs[i - 1]!.kind]).not.toEqual(["walk", "walk"]);
          expect(leg.arrival).toBeGreaterThanOrEqual(leg.departure);
        });
      }
    }
  });
});

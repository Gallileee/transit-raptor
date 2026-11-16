/**
 * The search reuses the labels of earlier searches on the same timetable (src/raptor.ts): an
 * answer must not depend on what was asked before it.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadFeed } from "../src/gtfs.js";
import { plan, profile, type Query } from "../src/raptor.js";
import { parseDate } from "../src/time.js";
import { buildTimetable } from "../src/timetable.js";

const MINI = join(import.meta.dirname, "fixtures", "mini");

describe("searches one after another", () => {
  it("answer as each would alone, in any order, for plans and profiles", async () => {
    const feed = await loadFeed(MINI, parseDate("2026-11-10"));
    const stops = feed.stops.map((_, i) => i);
    const queries: Query[] = [];
    for (const from of stops) {
      for (const to of stops) {
        if (from === to) continue;
        for (const departAt of [7 * 3600 + 50 * 60, 8 * 3600 + 7 * 60, 9 * 3600]) {
          queries.push({ from: [from], to: [to], departAt, maxTransfers: 1 + ((from + to) % 4), window: (from * to) % 3 === 0 ? 1800 : 0 });
        }
      }
    }
    const ask = (tt: ReturnType<typeof buildTimetable>, q: Query) => JSON.stringify(q.window ? profile(tt, q) : plan(tt, q));
    // Each alone: a timetable of its own, so nothing is reused.
    const alone = queries.map((q) => ask(buildTimetable(feed), q));
    // One after another on one timetable, forwards and backwards.
    const shared = buildTimetable(feed);
    expect(queries.map((q) => ask(shared, q))).toEqual(alone);
    expect(
      queries
        .map((q, i) => [i, ask(shared, q)] as const)
        .reverse()
        .every(([i, answer]) => answer === alone[i]),
    ).toBe(true);
    expect(alone.filter((a) => a !== "[]").length).toBeGreaterThan(50); // they find journeys
  });
});

describe("walking from where a search starts", () => {
  it("is never worse than starting at the stop walked to, a walk later", async () => {
    const feed = await loadFeed(MINI, parseDate("2026-11-10"));
    const tt = buildTimetable(feed);
    const earliest = (from: number, departAt: number, to: number) =>
      Math.min(...plan(tt, { from: [from], to: [to], departAt, maxTransfers: 4 }).map((j) => j.arrival));
    let checked = 0;
    for (let s = 0; s < feed.stops.length; s++) {
      for (const { to: next, seconds } of tt.footpaths[s]!) {
        for (let target = 0; target < feed.stops.length; target++) {
          if (target === s || target === next) continue;
          const viaWalk = earliest(next, 8 * 3600 + seconds, target);
          if (viaWalk === Infinity) continue;
          expect(earliest(s, 8 * 3600, target), `${feed.stops[s]!.id} -> ${feed.stops[target]!.id} via ${feed.stops[next]!.id}`).toBeLessThanOrEqual(viaWalk);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
  });
});

/**
 * The stops a ride makes between getting on and off, as the API lists them for the map.
 */
import { appendFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type LegJson, Planner } from "../src/service.js";

const MINI = join(import.meta.dirname, "fixtures", "mini");
const now = () => new Date(2026, 10, 10, 7, 58);

async function rides(planner: Planner, from: string, to: string, time: string) {
  const response = await planner.plan({ from, to, date: "2026-11-10", time, window: 0 });
  return response.journeys.map((j) => j.legs.filter((l): l is Extract<LegJson, { kind: "ride" }> => l.kind === "ride"));
}

describe("passed stops", () => {
  const planner = new Planner(MINI, now);

  it("lists the stops between getting on and off, with arrival times", async () => {
    const [direct] = await rides(planner, "Alpha", "Delta", "08:00");
    expect(direct!.map((r) => [r.line, r.stops])).toEqual([["300", 2]]);
    expect(direct![0]!.passed).toEqual([{ name: "Charlie", platform: "", lat: 50.02, lon: 14, arrival: "08:18" }]);
  });

  it("is empty for a ride of one stop, and the ends are never in it", async () => {
    const [, viaBravo] = await rides(planner, "Alpha", "Delta", "08:00");
    expect(viaBravo!.map((r) => [r.line, r.passed])).toEqual([
      ["1", []],
      ["200", []],
    ]);
  });

  it("gives a stop without a time in the feed the time it was filled in with", async () => {
    // L9a: Charlie 08:20, Bravo (2) with no times, Foxtrot North 08:25.
    const [ride] = (await rides(planner, "Charlie", "Foxtrot North", "08:20")).flat();
    expect(ride).toMatchObject({ line: "9", passed: [{ name: "Bravo", platform: "2", arrival: "08:20" }] });
  });

  describe("a stop the vehicle only drives past", () => {
    const dir = mkdtempSync(join(tmpdir(), "transit-raptor-passed-"));
    cpSync(MINI, dir, { recursive: true });
    // Bus 300 (L3express) passes Bravo (1) between Alpha and Charlie without stopping there.
    appendFileSync(join(dir, "stop_times.txt"), "L3express,08:10:00,08:10:00,B1,15,1,1,\n");
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("is counted as a stop of the ride but gets no dot", async () => {
      const [direct] = await rides(new Planner(dir, now), "Alpha", "Delta", "08:00");
      expect(direct![0]).toMatchObject({ line: "300", stops: 3 });
      expect(direct![0]!.passed.map((s) => s.name)).toEqual(["Charlie"]);
    });
  });
});

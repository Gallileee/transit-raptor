/**
 * Platforms without a platform_code take the track number their boarding areas are named after
 * ("Kolej 1"), as PID names them at the 14 metro platforms it leaves the code out at.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openFeed } from "../src/cache.js";
import { compileFeed } from "../src/gtfs.js";

const MINI = join(import.meta.dirname, "fixtures", "mini");

describe("platform codes from track names", () => {
  // Gamma's platforms M1 and M2 have no code. In this copy their boarding areas are named:
  // M1A "Kolej 1 - Start", M1B "Kolej 1" (agree), M2A "Kolej 2", M2B "Kolej 3" (don't), and
  // Bravo's platform 1 (code "1") gets an area named "Kolej 4".
  const dir = mkdtempSync(join(tmpdir(), "transit-raptor-tracks-"));
  cpSync(MINI, dir, { recursive: true });
  const named: Record<string, string> = { M1A: "Kolej 1 - Start", M1B: "Kolej 1", M2A: "Kolej 2", M2B: "Kolej 3" };
  const lines = readFileSync(join(MINI, "stops.txt"), "utf8").trimEnd().split("\n");
  writeFileSync(
    join(dir, "stops.txt"),
    [
      ...lines.map((line) => {
        const [id, , ...rest] = line.split(",");
        return named[id!] ? [id, named[id!], ...rest].join(",") : line;
      }),
      "B1K,Kolej 4,50.0400,14.0000,4,B1,,,",
    ].join("\n") + "\n",
  );
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const platform = async (id: string) => {
    const compiled = await compileFeed(dir);
    return compiled.stops.find((s) => s.id === id)!.platform;
  };

  it("fills in a missing code when all the platform's boarding areas name one track", async () => {
    expect(await platform("M1")).toBe("1");
  });

  it("leaves it empty when the areas name different tracks, and keeps a code the feed gives", async () => {
    expect(await platform("M2")).toBe("");
    expect(await platform("B1")).toBe("1");
  });

  it("goes into the cache like the rest of the stops", async () => {
    const cacheDir = join(dir, ".cache");
    await openFeed(dir, { cacheDir });
    const cached = await openFeed(dir, { cacheDir });
    expect(cached.source).toBe("cache");
    expect(cached.compiled.stops.find((s) => s.id === "M1")!.platform).toBe("1");
  });

  it("changes nothing in the test feed itself, whose areas aren't named after tracks", async () => {
    const compiled = await compileFeed(MINI);
    expect(["M1", "M2"].map((id) => compiled.stops.find((s) => s.id === id)!.platform)).toEqual(["", ""]);
  });
});

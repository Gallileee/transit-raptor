import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";

const MINI = join(import.meta.dirname, "fixtures", "mini");

async function run(...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: () => new Date(2026, 10, 10, 7, 58), // Tuesday 10 Nov 2026, 07:58 local time
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("cli", () => {
  it("plans a journey and prints every leg", async () => {
    const { code, out, err } = await run("plan", "--gtfs", MINI, "--from", "alpha", "--to", "delta", "--time", "08:00");
    expect(code).toBe(0);
    expect(out).toBe(
      [
        "Alpha -> Delta, Náměstí, 2026-11-10",
        "",
        "08:05 -> 08:30  (25 min, direct)",
        "  08:05–08:30  bus 300 towards Delta, Náměstí: Alpha -> Delta, Náměstí (2 stops)",
        "",
        "08:00 -> 08:15  (15 min, 1 transfer)",
        "  08:00–08:05  tram 1 towards Charlie: Alpha -> Bravo (1) (1 stop)",
        "  08:05–08:06  walk 1 min: Bravo (1) -> Bravo (2)",
        "  08:08–08:15  bus 200 towards Delta, Náměstí: Bravo (2) -> Delta, Náměstí (1 stop)",
      ].join("\n"),
    );
    expect(err).toMatch(/^Loaded 9 trips on 2026-11-10 \(\d+ patterns, 10 stops\) in \d+ ms; search \d+ ms$/);
  });

  it("defaults to now", async () => {
    const { code, out } = await run("plan", "--gtfs", MINI, "--from", "Alpha", "--to", "Delta", "--max-transfers", "0");
    expect(code).toBe(0);
    // 07:58 on Tuesday: without transfers, the 08:05 express beats the slow 08:00 bus.
    expect(out).toContain("08:05 -> 08:30  (25 min, direct)");
  });

  it("says when there is no journey", async () => {
    const { code, out } = await run("plan", "--gtfs", MINI, "--from", "Alpha", "--to", "Delta", "--date", "2026-11-14");
    expect(code).toBe(1);
    expect(out).toBe("No journey from Alpha to Delta, Náměstí with at most 4 transfers.");
  });

  it.each([
    [["plan", "--gtfs", MINI, "--from", "bra", "--to", "Delta"], '--from "bra" matches several stops: Bravo, Bravo Gate'],
    [["plan", "--gtfs", MINI, "--from", "zulu", "--to", "Delta"], '--from: no stop called "zulu"'],
    [["plan", "--gtfs", MINI, "--from", "Alpha"], "--from and --to are required"],
    [["plan", "--from", "Alpha", "--to", "Delta"], "--gtfs is required"],
    [["plan", "--gtfs", MINI, "--from", "A", "--to", "D", "--time", "noon"], 'not a time: "noon"'],
    [["plan", "--gtfs", MINI, "--from", "Alpha", "--to", "Delta", "--max-transfers=-1"], "--max-transfers must be"],
    [["plan", "--gtfs", MINI, "--from", "Alpha", "--to", "Delta", "--max-transfers", "two"], "--max-transfers must be"],
    [["plan", "--gtfs", join(MINI, "nope"), "--from", "A", "--to", "D"], "missing stops.txt"],
    [["fly"], 'unknown command "fly"'],
    [["plan", "--colour"], "Unknown option"],
  ])("rejects %j", async (args, message) => {
    const { code, err } = await run(...args);
    expect(code).toBe(2);
    expect(err).toContain(message);
  });

  it("lists stops", async () => {
    const { code, out } = await run("stops", "--gtfs", MINI, "--search", "foxtrot");
    expect(code).toBe(0);
    expect(out).toBe("Foxtrot North\nFoxtrot South");
  });
});

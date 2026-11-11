/**
 * The HTTP API and the page, on the test feed, through a real server on a free port.
 */
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAppServer } from "../src/server.js";
import { Planner } from "../src/service.js";

const MINI = join(import.meta.dirname, "fixtures", "mini");
const server = createAppServer(new Planner(MINI, () => new Date(2026, 10, 10, 7, 58)));
let base = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function get(path: string, init?: RequestInit) {
  const response = await fetch(base + path, init);
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, text, json: json as any };
}

describe("GET /api/plan", () => {
  it("returns journeys with names, times, colours and a path for the map", async () => {
    const { status, json, headers } = await get("/api/plan?from=alpha&to=delta&date=2026-11-10&time=08:00&window=0");
    expect(status).toBe(200);
    expect(headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(headers.get("cache-control")).toBe("no-store");
    expect([json.from, json.to, json.date, json.time]).toEqual(["Alpha", "Delta, Náměstí", "2026-11-10", "08:00"]);
    expect(json.journeys.map((j: any) => [j.departure, j.arrival, j.transfers, j.minutes])).toEqual([
      ["08:05", "08:30", 0, 25],
      ["08:00", "08:15", 1, 15],
    ]);
    const [ride, walk] = json.journeys[1].legs;
    expect(ride).toMatchObject({
      kind: "ride",
      mode: "tram",
      line: "1",
      headsign: "Charlie",
      from: { name: "Alpha", platform: "" },
      to: { name: "Bravo", platform: "1" },
      departure: "08:00",
      arrival: "08:05",
      stops: 1,
    });
    expect(ride.shape).toBe(true); // drawn along shapes.txt, not straight
    expect(ride.path).toEqual([
      [50, 14],
      [50.005, 14.002],
      [50.01, 14],
    ]);
    expect(walk).toMatchObject({ kind: "walk", minutes: 1, from: { platform: "1" }, to: { platform: "2" } });
  });

  it("draws every stop passed, not just the ends", async () => {
    const { json } = await get("/api/plan?from=alpha&to=delta&date=2026-11-10&time=08:00&window=0&maxTransfers=0");
    // The express stops at Charlie between Alpha and Delta.
    expect(json.journeys[0].legs[0].path).toEqual([
      [50, 14],
      [50.02, 14],
      [50.03, 14],
    ]);
  });

  it("uses the window and --list like the CLI", async () => {
    const windowed = await get("/api/plan?from=charlie&to=echo&date=2026-11-10&time=08:15");
    expect(windowed.json.journeys.map((j: any) => j.departure)).toEqual(["08:23"]);
    const all = await get("/api/plan?from=alpha&to=delta&date=2026-11-10&time=07:50&list=1");
    expect(all.json.journeys.map((j: any) => `${j.departure}-${j.arrival}`)).toEqual(["08:00-08:15", "08:05-08:30", "08:10-08:25"]);
  });

  it("plans step-free with stepFree=1", async () => {
    const query = "/api/plan?from=alpha&to=charlie&date=2026-11-10&time=08:00&window=0";
    const normal = await get(query);
    const stepFree = await get(`${query}&stepFree=1`);
    expect([normal.json.stepFree, normal.json.journeys[0].legs[0].line]).toEqual([false, "1"]);
    expect([stepFree.json.stepFree, stepFree.json.journeys[0].legs[0].line]).toEqual([true, "300"]);
    expect((await get(`${query}&stepFree=0`)).json.stepFree).toBe(false);
  });

  it("defaults to the planner's today and now", async () => {
    const { json } = await get("/api/plan?from=alpha&to=delta");
    expect([json.date, json.time]).toEqual(["2026-11-10", "07:58"]);
  });

  it("reports colours from routes.txt, normalized, and drops ones that aren't hex", async () => {
    const { json } = await get("/api/plan?from=alpha&to=echo&date=2026-11-10&time=08:55");
    const [line11, , line12] = json.journeys[0].legs;
    expect(line11).toMatchObject({ line: "11", mode: "metro", color: "00A562", textColor: "FFFFFF" });
    expect(line12).toMatchObject({ line: "12", color: "", textColor: "" }); // route_color "green"
  });

  it.each([
    ["from=zulu&to=delta", 'from: no stop called "zulu"', []],
    ["from=bra&to=delta", 'from: "bra" matches several stops', ["Bravo", "Bravo Gate"]],
    ["from=alpha&to=", "to is required", []],
    ["from=alpha&to=delta&time=noon", 'not a time: "noon" (use HH:MM)', []],
    ["from=alpha&to=delta&date=2026-02-30", 'no such date: "2026-02-30"', []],
    ["from=alpha&to=delta&window=-1", "window must be a whole number of minutes from 0 to 1440", []],
    ["from=alpha&to=delta&maxTransfers=x", "maxTransfers must be a number", []],
  ])("400 for %s", async (query, error, suggestions) => {
    const { status, json } = await get(`/api/plan?${query}`);
    expect(status).toBe(400);
    expect(json).toEqual({ error, suggestions });
  });
});

describe("GET /api/stops", () => {
  it("suggests names", async () => {
    expect((await get("/api/stops?q=foxtrot")).json).toEqual(["Foxtrot North", "Foxtrot South"]);
    expect((await get("/api/stops?q=delta%20namesti")).json).toEqual(["Delta, Náměstí"]);
    expect((await get("/api/stops?q=")).json).toEqual([]);
  });
});

describe("the page and everything else", () => {
  it("serves the page with a content security policy", async () => {
    const { status, text, headers } = await get("/");
    expect(status).toBe(200);
    expect(headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(headers.get("content-security-policy")).toContain("script-src 'self' https://cdnjs.cloudflare.com");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(text).toContain('<script src="/app.js" type="module"></script>');
    expect((await get("/app.js")).headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect((await get("/style.css")).status).toBe(200);
  });

  it.each(["/index.html", "/../package.json", "/%2e%2e/package.json", "/web/app.js", "/api/nope"])("404 for %s", async (path) => {
    const { status, json } = await get(path);
    expect(status).toBe(404);
    expect(json).toEqual({ error: "not found" });
  });

  it("405 for other methods", async () => {
    const { status, headers } = await get("/api/plan?from=alpha&to=delta", { method: "POST" });
    expect(status).toBe(405);
    expect(headers.get("allow")).toBe("GET, HEAD");
  });

  it("503 when the feed can't be loaded", async () => {
    const broken = createAppServer(new Planner(join(MINI, "missing")));
    await new Promise<void>((resolve) => broken.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(broken.address() as AddressInfo).port}/api/plan?from=a&to=b&date=2026-11-10`;
    const response = await fetch(url);
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toMatch(/^the timetable can't be loaded: .*missing stops\.txt/);
    await new Promise<void>((resolve) => broken.close(() => resolve()));
  });
});

describe("Planner cache", () => {
  it("loads a date once and keeps only the most recent ones", async () => {
    const planner = new Planner(MINI, () => new Date(2026, 10, 10), 2);
    const tuesday = { year: 2026, month: 11, day: 10 };
    const a = planner.load(tuesday);
    expect(planner.load(tuesday)).toBe(a);
    planner.load({ year: 2026, month: 11, day: 11 });
    planner.load({ year: 2026, month: 11, day: 12 }); // pushes out the 10th
    expect(planner.load(tuesday)).not.toBe(a);
    await Promise.all([a]);
  });
});

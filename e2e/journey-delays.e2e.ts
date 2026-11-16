/**
 * Live delays in the journey list. The test server has no Golemio key, so the API's answer is
 * given the live data a key would bring (the server's side is tested in tests/journey-delays).
 */
import { expect, searchUrl, test } from "./fixtures.js";

const journeys = (page: import("@playwright/test").Page) => page.locator("#results").getByRole("option");
const search = searchUrl({ from: "alpha", to: "delta", time: "08:00", date: "2026-11-10", window: "0" });

async function answerWith(page: import("@playwright/test").Page, change: (body: any) => void) {
  await page.route("**/api/plan?*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    change(body);
    await route.fulfill({ response, json: body });
  });
}

test("shows each ride's delay and warns about a change that may be missed", async ({ page }) => {
  await answerWith(page, (body) => {
    body.live = "on";
    const [direct, viaBravo] = body.journeys;
    direct.legs[0].delay = 20; // bus 300: on time
    viaBravo.legs[0].delay = 150; // tram 1: +2 min
    viaBravo.legs[2].changeAtRisk = true; // so the bus at Bravo may be gone
  });
  await page.goto(search);
  await expect(page.getByRole("status")).toContainText("2 journeys");
  await expect(page.getByRole("status")).toContainText("· live delays from PID");
  const [direct, viaBravo] = [journeys(page).nth(0), journeys(page).nth(1)];
  await expect(direct.locator(".leg").first().locator(".delay")).toHaveText("on time");
  await expect(direct.locator(".leg").first().locator(".delay")).toHaveClass("delay on-time");
  await expect(viaBravo.locator(".leg").nth(0).locator(".delay")).toHaveText("+2 min");
  await expect(viaBravo.locator(".leg").nth(0).locator(".delay")).toHaveCSS("font-weight", "600");
  await expect(viaBravo.locator(".leg").nth(2).locator(".risk")).toHaveText("The vehicle before is late: this change may be missed");
  await expect(viaBravo.locator(".leg").nth(2).locator(".delay")).toHaveCount(0); // its own delay isn't known
  await expect(page.locator(".risk")).toHaveCount(1);
});

test("says when a ride is cancelled", async ({ page }) => {
  await answerWith(page, (body) => {
    body.live = "on";
    body.journeys[0].legs[0].canceled = true;
    body.journeys[0].legs[0].delay = 0;
    body.journeys[0].legs[0].changeAtRisk = true; // the cancellation says more
  });
  await page.goto(search);
  const ride = journeys(page).first().locator(".leg").first();
  await expect(ride.locator(".risk")).toHaveCount(1);
  await expect(ride.locator(".risk")).toHaveText("bus 300 at 08:05 is canceled");
  await expect(ride.locator(".delay")).toHaveCount(0);
});

test("says when the live delays aren't available, and nothing when they are off", async ({ page }) => {
  let live = "error";
  await answerWith(page, (body) => {
    body.live = live;
  });
  await page.goto(search);
  await expect(page.getByRole("status")).toHaveText(/2 journeys \(\d+ ms\) · live delays unavailable$/);
  live = "off";
  await page.getByRole("button", { name: "Find journeys" }).click();
  await expect(page.getByRole("status")).toHaveText(/2 journeys \(\d+ ms\)$/);
  await expect(page.locator(".delay, .risk")).toHaveCount(0);
});

test("says how to go on if a change at risk is missed, and searches from there", async ({ page }) => {
  await answerWith(page, (body) => {
    if (body.from !== "Alpha") return; // the search from Bravo is answered as it is
    body.live = "on";
    const viaBravo = body.journeys[1];
    viaBravo.legs[0].delay = 150;
    viaBravo.legs[2].changeAtRisk = true;
    viaBravo.fallback = {
      leg: 2,
      from: viaBravo.legs[0].to,
      at: "08:07",
      journey: {
        departure: "08:16",
        arrival: "08:25",
        minutes: 9,
        transfers: 0,
        legs: [{ ...viaBravo.legs[2], departure: "08:18", arrival: "08:25", delay: null, changeAtRisk: false }],
      },
      later: 10,
    };
  });
  await page.goto(search);
  const viaBravo = journeys(page).nth(1);
  const fallback = viaBravo.locator(".leg").nth(2).locator(".fallback");
  await expect(fallback).toHaveText("If you miss it: bus 200 at 08:18 from Bravo (2), arriving 08:25 (10 min later). Search from there");
  await expect(page.locator(".fallback")).toHaveCount(1);
  await fallback.getByRole("link", { name: "Search from there" }).click();
  await expect(page).toHaveURL(/\?from=Bravo&to=Delta%2C\+N%C3%A1m%C4%9Bst%C3%AD&date=2026-11-10&time=08%3A16&window=0$/);
  await expect(page.getByRole("status")).toContainText("1 journey");
  await expect(journeys(page).first().locator("h2")).toContainText("08:18 → 08:25");
});

test("says when nothing goes on from where the late vehicle leaves one", async ({ page }) => {
  await answerWith(page, (body) => {
    body.live = "on";
    body.journeys[1].legs[2].changeAtRisk = true;
    body.journeys[1].fallback = { leg: 2, from: body.journeys[1].legs[0].to, at: "08:30", journey: null, later: null };
  });
  await page.goto(search);
  await expect(page.locator(".fallback")).toHaveText("If you miss it: nothing more from Bravo (1) today. Search from there");
});

test("says how to go on without a cancelled ride", async ({ page }) => {
  await answerWith(page, (body) => {
    body.live = "on";
    const direct = body.journeys[0];
    direct.legs[0].canceled = true;
    direct.legs[0].delay = 0;
    direct.fallback = {
      leg: 0,
      reason: "canceled",
      from: direct.legs[0].from,
      at: "08:05",
      journey: body.journeys[1],
      later: -15,
    };
  });
  await page.goto(search);
  const ride = journeys(page).first().locator(".leg").first();
  await expect(ride.locator(".risk")).toHaveText("bus 300 at 08:05 is canceled");
  await expect(ride.locator(".fallback")).toHaveText(
    "Instead: tram 1 at 08:00 from Alpha, then bus 200 at 08:08 from Bravo (2), arriving 08:15. Search from there",
  );
  await expect(ride.getByRole("link", { name: "Search from there" })).toHaveAttribute("href", /from=Alpha&.*time=08%3A00&window=0/);
});

test("says which cancelled trips the journeys were planned around, and only for that search", async ({ page }) => {
  const bus300 = { mode: "bus", line: "300", headsign: "Delta, Náměstí", from: { name: "Alpha", platform: "", lat: 50, lon: 14 }, departure: "08:05" };
  let avoided: unknown[] = [bus300];
  await answerWith(page, (body) => {
    body.live = "on";
    body.avoided = avoided;
  });
  await page.goto(search);
  await expect(page.locator("#avoided")).toHaveText("Planned around a cancelled trip: bus 300 at 08:05 from Alpha.");
  avoided = [
    ...avoided,
    { mode: "bus", line: "200", headsign: "Delta, Náměstí", from: { name: "Bravo", platform: "2", lat: 50, lon: 14 }, departure: "08:08" },
  ];
  await page.getByRole("button", { name: "Find journeys" }).click();
  await expect(page.locator("#avoided")).toHaveText("Planned around 2 cancelled trips: bus 300 at 08:05 from Alpha, bus 200 at 08:08 from Bravo (2).");
  avoided = [];
  await page.getByRole("button", { name: "Find journeys" }).click();
  await expect(page.getByRole("status")).toContainText("2 journeys");
  await expect(page.locator("#avoided")).toBeHidden();
  // A search that fails doesn't leave the last one's note either.
  avoided = [bus300];
  await page.getByRole("button", { name: "Find journeys" }).click();
  await expect(page.locator("#avoided")).toBeVisible();
  await page.getByLabel("From", { exact: true }).fill("Nowhere at all");
  await page.getByRole("button", { name: "Find journeys" }).click();
  await expect(page.getByRole("status")).toContainText("no stop called");
  await expect(page.locator("#avoided")).toBeHidden();
});

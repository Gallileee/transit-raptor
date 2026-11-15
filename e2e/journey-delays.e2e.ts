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

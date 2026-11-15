/**
 * From a journey to the departures board of a stop on it: the stop names in the list and the
 * dots on the map link to the board at that stop and time (on the test feed, Tuesday 10 Nov).
 */
import { expect, searchUrl, test } from "./fixtures.js";

const TUESDAY = { date: "2026-11-10", window: "0" };
const journeys = (page: import("@playwright/test").Page) => page.locator("#results").getByRole("option");
const rows = (page: import("@playwright/test").Page) => page.locator("#departures tbody tr");

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date(2026, 10, 10, 7, 50, 0) });
});

test("the stop one gets on at links to its departures at that time", async ({ page }) => {
  await page.goto(searchUrl({ from: "alpha", to: "delta", time: "08:00", ...TUESDAY }));
  const link = journeys(page).first().getByRole("link", { name: "Alpha" });
  await expect(link).toHaveAttribute("href", "/departures?stop=Alpha&date=2026-11-10&time=08%3A05");
  await expect(link).toHaveAttribute("title", "Departures from Alpha at 08:05");
  await link.click();

  await expect(page.locator("#departures caption")).toHaveText("Next departures from Alpha");
  await expect(page.locator("#updated")).toHaveText("Timetable for 10 Nov 2026 at 08:05 · Show departures from now");
  // Counted from 08:05, the bus of the journey first; then the board stays as it is.
  await expect(rows(page).first().locator("td").nth(0)).toHaveText("08:05");
  await expect(rows(page).first().locator(".in")).toHaveText("now");
  await expect(rows(page).nth(1).locator(".in")).toHaveText("5 min");
  const asked: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/departures")) asked.push(r.url());
  });
  await page.clock.runFor(120_000);
  await expect(rows(page).first().locator("td").nth(0)).toHaveText("08:05");
  expect(asked).toEqual([]);
});

test("the planned board switches to now", async ({ page }) => {
  await page.goto("/departures?stop=alpha&date=2026-11-10&time=08:05");
  await expect(rows(page).first().locator("td").nth(0)).toHaveText("08:05");
  await page.getByRole("link", { name: "Show departures from now" }).click();
  // 07:50 on the clock: the 08:00 departures come first again, and the board refreshes itself.
  await expect(rows(page).first().locator("td").nth(0)).toHaveText("08:00");
  await expect(page.locator("#updated")).toHaveText("Updated 07:50:00");
  expect(new URL(page.url()).search).toBe("?stop=Alpha");
});

test("Enter on the link follows it instead of selecting the journey", async ({ page }) => {
  await page.goto(searchUrl({ from: "alpha", to: "delta", time: "08:00", ...TUESDAY }));
  await journeys(page).nth(1).getByRole("link", { name: "Alpha" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/departures\?stop=Alpha&date=2026-11-10&time=08%3A00$/);
});

test("the dots on the map open a popup with a link to the departures", async ({ page }) => {
  await page.goto(searchUrl({ from: "alpha", to: "delta", time: "08:00", ...TUESDAY }));
  await expect(journeys(page)).toHaveCount(2);
  await page.waitForTimeout(400); // Leaflet's zoom animation
  // The dot where the ride starts (white with a dark ring; the stops on the way have their own class).
  await page.locator('.leaflet-overlay-pane path[stroke="#1c2430"][fill="#fff"]:not(.passed-stop)').first().click();
  const popup = page.locator(".leaflet-popup-content");
  await expect(popup).toContainText("08:05 Alpha");
  await expect(popup.getByRole("link", { name: "Departures from here" })).toHaveAttribute(
    "href",
    "/departures?stop=Alpha&date=2026-11-10&time=08%3A05",
  );
});

test("after midnight the link goes to the next day's board", async ({ page }) => {
  // Night bus 905: Alpha 23:55, Delta 00:30 the next day.
  await page.goto(searchUrl({ from: "alpha", to: "delta", time: "23:50", ...TUESDAY }));
  await expect(journeys(page)).toHaveCount(1);
  await page.waitForTimeout(400);
  await page.locator('.leaflet-overlay-pane path[stroke="#1c2430"][fill="#1c2430"]').click(); // the end
  await expect(page.locator(".leaflet-popup-content")).toContainText("00:30 (+1) Delta, Náměstí");
  await expect(page.locator(".leaflet-popup-content a")).toHaveAttribute(
    "href",
    "/departures?stop=Delta%2C+N%C3%A1m%C4%9Bst%C3%AD&date=2026-11-11&time=00%3A30",
  );
});

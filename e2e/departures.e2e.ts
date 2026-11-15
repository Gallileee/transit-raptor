/**
 * The departures board (/departures) in a real browser, on the test feed, with the browser's
 * clock under the test's control: Tuesday 10 Nov 2026, 07:58 at Alpha.
 */
import { expect, test } from "./fixtures.js";

const rows = (page: import("@playwright/test").Page) => page.locator("#departures tbody tr");
const cells = async (page: import("@playwright/test").Page) =>
  (await rows(page).all()).map(async (row) => (await row.locator("td").allInnerTexts()).map((t) => t.trim()));

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date(2026, 10, 10, 7, 58, 0) });
});

test("shows the next departures of the stop in the URL", async ({ page }) => {
  await page.goto("/departures?stop=alpha");
  await expect(page.locator("#departures caption")).toHaveText("Next departures from Alpha");
  await expect(rows(page)).toHaveCount(5);
  expect(await Promise.all(await cells(page))).toEqual([
    ["08:00", "2 min", "1", "Charlie", ""],
    ["08:00", "2 min", "300", "Delta, Náměstí", ""],
    ["08:05", "7 min", "300", "Delta, Náměstí", ""],
    ["08:10", "12 min", "1", "Charlie", ""],
    ["09:00", "62 min", "11", "Gamma", ""],
  ]);
  await expect(page.locator("#stop")).toHaveValue("Alpha");
  // The metro's colours from routes.txt; the step-free bus says so on its badge.
  await expect(rows(page).nth(4).locator(".badge")).toHaveCSS("background-color", "rgb(0, 165, 98)");
  await expect(rows(page).nth(2).locator(".badge")).toHaveAttribute("title", "bus · step-free");
  await expect(page.locator("#updated")).toHaveText("Updated 07:58:00");
});

test("counts down, drops what has left, and asks again every 30 s", async ({ page }) => {
  const asked: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/departures")) asked.push(new URL(r.url()).searchParams.get("time")!);
  });
  await page.goto("/departures?stop=alpha");
  await expect(rows(page)).toHaveCount(5);
  expect(asked).toEqual(["07:58"]);

  // Each refresh is planned 30 s after the previous answer, so a little later each time.
  await page.clock.runFor(31_000); // 07:58:31
  await expect.poll(() => asked).toEqual(["07:58", "07:58"]);
  await page.clock.runFor(31_000); // 07:59:02: the countdown has moved
  await expect.poll(() => asked).toEqual(["07:58", "07:58", "07:59"]);
  await expect(rows(page).first().locator(".in")).toHaveText("1 min");

  await page.clock.runFor(90_000); // 08:00:32: the 08:00 departures leave now
  await expect(rows(page).first().locator(".in")).toHaveText("now");
  await page.clock.runFor(60_000); // 08:01:32: they're gone
  await expect(rows(page).first().locator(".time")).toHaveText("08:05");
});

test("keeps counting down while the server doesn't answer", async ({ page }) => {
  await page.goto("/departures?stop=alpha");
  await expect(rows(page)).toHaveCount(5);
  // From now on every refresh hangs: only the page's own clock moves the board.
  await page.route("**/api/departures?*", () => {});
  await page.clock.runFor(62_000); // 07:59:02
  await expect(rows(page).first().locator(".in")).toHaveText("1 min");
  await page.clock.runFor(150_000); // 08:01:32: the 08:00 departures have left
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).first().locator(".time")).toHaveText("08:05");
  await expect(page.locator("#updated")).toHaveText("Updated 07:58:00");
});

test("an ambiguous stop offers the names; picking one shows its board and keeps it in the URL", async ({ page }) => {
  await page.goto("/departures");
  await page.getByLabel("Stop").fill("foxtrot");
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page.getByRole("status")).toHaveText('stop: "foxtrot" matches several stops');
  await expect(page.locator("#departures")).toBeHidden();
  await page.locator("#suggestions").getByRole("button", { name: "Foxtrot South" }).click();
  await expect(page.locator("#departures caption")).toHaveText("Next departures from Foxtrot South");
  await expect(page.locator("#suggestions")).toBeHidden();
  expect(new URL(page.url()).searchParams.get("stop")).toBe("Foxtrot South");
});

test("says when nothing leaves", async ({ page }) => {
  await page.goto("/departures?stop=delta"); // trips only end there
  await expect(page.getByRole("status")).toHaveText("No departures from Delta, Náměstí in the next 2 hours.");
  await expect(page.locator("#departures")).toBeHidden();
});

test("links to and from the journey planner", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("navigation", { name: "Pages" }).getByRole("link", { name: "Departures" }).click();
  await expect(page).toHaveURL(/\/departures$/);
  await page.getByRole("navigation", { name: "Pages" }).getByRole("link", { name: "Journeys" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  test("fits the width", async ({ page }) => {
    await page.goto("/departures?stop=alpha");
    await expect(rows(page)).toHaveCount(5);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(375);
  });
});

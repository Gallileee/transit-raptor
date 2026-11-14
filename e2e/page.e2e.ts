/**
 * The web page in a real browser, on the test feed (tests/fixtures/mini): what a person
 * sees and does, and the map drawn with Leaflet. The API itself is tested in tests/server.test.ts.
 */
import { expect, searchUrl, test } from "./fixtures.js";

const TUESDAY = { date: "2026-11-10", window: "0" };
const status = (page: import("@playwright/test").Page) => page.getByRole("status");
const journeys = (page: import("@playwright/test").Page) => page.locator("#results").getByRole("option");
/** The lines and dots Leaflet draws on the map (SVG paths in the overlay pane). */
const drawn = (page: import("@playwright/test").Page) => page.locator(".leaflet-overlay-pane path");

/** Every line and dot of the selected journey lies inside the visible map (fitBounds worked). */
async function expectJourneyInsideMap(page: import("@playwright/test").Page) {
  await page.waitForTimeout(400); // Leaflet's zoom animation
  const map = (await page.locator("#map").boundingBox())!;
  for (const path of await drawn(page).all()) {
    const box = (await path.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(map.x - 1);
    expect(box.y).toBeGreaterThanOrEqual(map.y - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(map.x + map.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(map.y + map.height + 1);
  }
}

test("plans the journey in the URL, lists it and draws the first one", async ({ page }) => {
  await page.goto(searchUrl({ from: "alpha", to: "delta", time: "08:00", ...TUESDAY }));
  await expect(status(page)).toContainText("Alpha → Delta, Náměstí, 2026-11-10: 2 journeys");
  await expect(journeys(page)).toHaveCount(2);
  const [direct, viaBravo] = [journeys(page).nth(0), journeys(page).nth(1)];
  await expect(direct.getByRole("heading")).toHaveText("08:05 → 08:3025 min · direct");
  await expect(viaBravo.getByRole("heading")).toHaveText("08:00 → 08:1515 min · 1 change");
  await expect(viaBravo.locator(".badge.walk")).toHaveText("walk");
  await expect(direct).toHaveAttribute("aria-selected", "true");
  // One ride: its line, a dot for the stop on the way (Charlie), a dot where it starts and one at the end.
  await expect(drawn(page)).toHaveCount(4);
  await expectJourneyInsideMap(page);
});

test("selects another journey by click and by keyboard, and redraws the map", async ({ page }) => {
  await page.goto(searchUrl({ from: "alpha", to: "delta", time: "08:00", ...TUESDAY }));
  await expect(journeys(page)).toHaveCount(2);
  await journeys(page).nth(1).click();
  await expect(journeys(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(journeys(page).nth(0)).toHaveAttribute("aria-selected", "false");
  // Ride, walk, ride: three lines, three starting dots, one end dot; the walk is dashed.
  await expect(drawn(page)).toHaveCount(7);
  await expect(page.locator('.leaflet-overlay-pane path[stroke-dasharray="6 6"]')).toHaveCount(1);

  await journeys(page).nth(0).focus();
  await page.keyboard.press("Enter");
  await expect(journeys(page).nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(drawn(page)).toHaveCount(4);
});

test("shows the stops on the way as dots in the line's colour, and as a list", async ({ page }) => {
  await page.goto(searchUrl({ from: "alpha", to: "echo", time: "08:55", ...TUESDAY }));
  await expect(journeys(page).first()).toBeVisible();
  // Metro 11 Alpha -> Gamma has no stop on the way.
  await expect(page.locator(".leaflet-overlay-pane path.passed-stop")).toHaveCount(0);

  await page.goto(searchUrl({ from: "alpha", to: "delta", time: "08:00", ...TUESDAY }));
  const dots = page.locator(".leaflet-overlay-pane path.passed-stop");
  await expect(dots).toHaveCount(1);
  await expect(dots).toHaveAttribute("stroke", "#0b5cad"); // bus 300 has no route_color: the default
  await expectJourneyInsideMap(page);
  await dots.hover({ force: true });
  await expect(page.locator(".leaflet-tooltip")).toHaveText("08:18 Charlie");

  const list = journeys(page).first().locator("details.passed");
  await expect(list.locator("summary")).toHaveText("1 stop in between");
  await expect(list.locator("li")).toBeHidden();
  await list.locator("summary").click();
  await expect(list.locator("li")).toHaveText(["08:18Charlie"]);
  // Opening the list with the keyboard doesn't select another journey.
  await expect(journeys(page).nth(1).locator("details.passed")).toHaveCount(0); // its rides make no stop on the way
  await list.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(list.locator("li")).toBeHidden();
  await expect(journeys(page).first()).toHaveAttribute("aria-selected", "true");
});

test("searches from the form, suggests stop names, and keeps the search in the URL", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Date").fill("2026-11-10");
  await page.getByLabel("Time").fill("08:00");
  await page.getByLabel("Leaving within").selectOption("0");
  await page.getByLabel("From", { exact: true }).fill("alp");
  await expect(page.locator("#from-list option")).toHaveAttribute("value", "Alpha");
  await page.getByLabel("From", { exact: true }).fill("Alpha");
  await page.getByLabel("To", { exact: true }).fill("Delta");
  await page.getByRole("button", { name: "Find journeys" }).click();
  await expect(journeys(page)).toHaveCount(2);

  const url = new URL(page.url());
  expect(Object.fromEntries(url.searchParams)).toEqual({
    from: "Alpha",
    to: "Delta",
    date: "2026-11-10",
    time: "08:00",
    window: "0",
  });
  await page.reload();
  await expect(journeys(page)).toHaveCount(2);

  await page.getByRole("button", { name: "Swap from and to" }).click();
  await expect(page.getByLabel("From", { exact: true })).toHaveValue("Delta");
  await expect(page.getByLabel("To", { exact: true })).toHaveValue("Alpha");
});

test("an ambiguous stop offers the names to pick from, and picking one searches", async ({ page }) => {
  await page.goto(searchUrl({ from: "bra", to: "delta", time: "08:00", ...TUESDAY }));
  await expect(status(page)).toHaveText('from: "bra" matches several stops');
  await expect(status(page)).toHaveClass(/error/);
  const choices = page.locator("#suggestions").getByRole("button");
  await expect(choices).toHaveText(["Bravo", "Bravo Gate"]);
  await choices.first().click();
  await expect(page.getByLabel("From", { exact: true })).toHaveValue("Bravo");
  await expect(status(page)).not.toHaveClass(/error/);
  await expect(page.locator("#suggestions")).toBeHidden();
  await expect(journeys(page).first()).toBeVisible();
});

test("an unknown stop is an error without suggestions, and the page keeps working", async ({ page }) => {
  await page.goto(searchUrl({ from: "zulu", to: "delta", time: "08:00", ...TUESDAY }));
  await expect(status(page)).toHaveText('from: no stop called "zulu"');
  await expect(page.locator("#suggestions")).toBeHidden();
  await expect(journeys(page)).toHaveCount(0);
});

test("the step-free checkbox changes the journeys and is kept in the URL", async ({ page }) => {
  await page.goto(searchUrl({ from: "alpha", to: "charlie", time: "08:00", ...TUESDAY }));
  await expect(journeys(page).first().locator(".badge").first()).toHaveText("1"); // tram 1: not step-free
  await page.getByLabel("step-free").check();
  await page.getByRole("button", { name: "Find journeys" }).click();
  await expect(status(page)).toContainText("1 step-free journey");
  expect(new URL(page.url()).searchParams.get("stepFree")).toBe("1");
  const badge = journeys(page).first().locator(".badge").first();
  await expect(badge).toHaveText("300");
  await expect(badge).toHaveAttribute("title", "bus · step-free");

  await page.reload();
  await expect(page.getByLabel("step-free")).toBeChecked();
  await expect(status(page)).toContainText("1 step-free journey");
});

test("says when there is no step-free journey", async ({ page }) => {
  await page.goto(searchUrl({ from: "charlie", to: "foxtrot north", time: "08:15", stepFree: "1", ...TUESDAY }));
  await expect(status(page)).toHaveText("No step-free journey from Charlie to Foxtrot North.");
  await expect(journeys(page)).toHaveCount(0);
});

test("line badges use the feed's colours, and only valid ones", async ({ page }) => {
  await page.goto(searchUrl({ from: "alpha", to: "echo", time: "08:55", ...TUESDAY }));
  const badges = journeys(page).first().locator(".badge:not(.walk)");
  await expect(badges.first()).toHaveText("11");
  await expect(badges.first()).toHaveCSS("background-color", "rgb(0, 165, 98)"); // route_color 00A562
  await expect(badges.first()).toHaveCSS("color", "rgb(255, 255, 255)");
  // Line 12's route_color is "green": not a hex colour, so the page's default stays.
  await expect(badges.nth(1)).toHaveText("12");
  await expect(badges.nth(1)).not.toHaveAttribute("style", /background/);
});

test("each journey's minutes match the times shown next to them", async ({ page }) => {
  await page.goto(searchUrl({ from: "alpha", to: "delta", time: "07:30", date: "2026-11-10", window: "120" }));
  await expect(journeys(page).first()).toBeVisible();
  for (const heading of await journeys(page).getByRole("heading").all()) {
    const text = (await heading.textContent()) ?? "";
    const [, h1, m1, h2, m2, minutes] = /^(\d\d):(\d\d) → (\d\d):(\d\d)(\d+) min/.exec(text) ?? [];
    expect(text).toMatch(/min/);
    expect(Number(minutes)).toBe(Number(h2) * 60 + Number(m2) - (Number(h1) * 60 + Number(m1)));
  }
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  test("fits the width and shows the map under the journeys", async ({ page }) => {
    await page.goto(searchUrl({ from: "alpha", to: "delta", time: "08:00", ...TUESDAY }));
    await expect(journeys(page)).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    const list = await page.locator("#results").boundingBox();
    const map = await page.locator("#map").boundingBox();
    expect(map!.y).toBeGreaterThanOrEqual(list!.y + list!.height);
    expect(map!.height).toBeGreaterThan(200);
    await journeys(page).nth(1).tap();
    await expect(drawn(page)).toHaveCount(7);
    await page.locator("#map").scrollIntoViewIfNeeded();
    await expectJourneyInsideMap(page);
  });
});

test("follows the system's dark mode", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.emulateMedia({ colorScheme: "dark" });
  const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(dark).not.toBe(light);
  const brightness = (rgb: string) => rgb.match(/\d+/g)!.slice(0, 3).reduce((sum, v) => sum + Number(v), 0);
  expect(brightness(dark)).toBeLessThan(brightness(light));
});

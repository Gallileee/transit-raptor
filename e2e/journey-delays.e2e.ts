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
  await expect(viaBravo.locator(".leg").nth(2).locator(".risk")).toHaveText("The vehicle before is late: this change may be missed Show stop on map");
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
  await expect(ride.locator(".risk")).toHaveText("bus 300 at 08:05 is canceled Show stop on map");
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
  await expect(fallback).toHaveText("If you miss it: bus 200 at 08:18 from Bravo (2), arriving 08:25 (10 min later). Search from there Show on map");
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
  await expect(ride.locator(".risk")).toHaveText("bus 300 at 08:05 is canceled Show stop on map");
  await expect(ride.locator(".fallback")).toHaveText(
    "Instead: tram 1 at 08:00 from Alpha, then bus 200 at 08:08 from Bravo (2), arriving 08:15. Search from there Show on map",
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

/** The lines and dots Leaflet draws on the map (SVG paths in the overlay pane). */
const drawn = (page: import("@playwright/test").Page) => page.locator(".leaflet-overlay-pane path");

/** Journey 2 (tram 1, walk, bus 200) with bus 200 at risk; the way on is the next bus 200. */
function missedAtBravo(body: any) {
  if (body.from !== "Alpha") return;
  body.live = "on";
  const viaBravo = body.journeys[1];
  viaBravo.legs[0].delay = 150;
  viaBravo.legs[2].changeAtRisk = true;
  viaBravo.fallback = {
    leg: 2,
    reason: "late",
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
}

test("draws the way on if a change is missed, dotted under the journey", async ({ page }) => {
  await answerWith(page, missedAtBravo);
  await page.goto(search);
  await expect(drawn(page)).toHaveCount(4); // the direct journey: no fallback, nothing dotted
  await expect(page.locator("path.fallback-leg")).toHaveCount(0);

  await journeys(page).nth(1).click();
  // Ride, walk, ride: 3 lines + 4 dots, the way on: its line and a dot where it is boarded, and
  // the warning (a ring and its halo) where the bus at risk is boarded.
  await expect(drawn(page)).toHaveCount(11);
  const line = page.locator("path.fallback-leg");
  await expect(line).toHaveCount(1);
  await expect(line).toHaveAttribute("stroke-dasharray", "1 10");
  await expect(line).toHaveAttribute("stroke-linecap", "round");
  // Drawn first, so the journey's own lines lie over it where they share a street.
  await expect(drawn(page).first()).toHaveClass(/fallback-leg/);
  const dot = page.locator("path.fallback-stop");
  await expect(dot).toHaveCount(1);
  // Under the journey's own dot at Bravo (2), so the tooltip is asked for directly.
  await dot.dispatchEvent("mouseover");
  await expect(page.locator(".leaflet-tooltip")).toHaveText("If you miss it: 08:18 Bravo (2)");

  // Another journey without one takes it off again.
  await journeys(page).nth(0).click();
  await expect(page.locator("path.fallback-leg, path.fallback-stop")).toHaveCount(0);
});

test("'Show on map' selects the journey and zooms the map to the way on", async ({ page }) => {
  await answerWith(page, missedAtBravo);
  await page.goto(search);
  await expect(journeys(page).nth(0)).toHaveAttribute("aria-selected", "true");
  const button = journeys(page).nth(1).getByRole("button", { name: "Show on map" });
  await button.click();
  await expect(journeys(page).nth(1)).toHaveAttribute("aria-selected", "true");
  const line = page.locator("path.fallback-leg");
  await expect(line).toHaveCount(1);
  const map = (await page.locator("#map").boundingBox())!;
  // Centred on the way on (Leaflet zooms in whole steps, so its size alone may not change).
  const offCentre = (box: { x: number; y: number; width: number; height: number }) =>
    Math.hypot(box.x + box.width / 2 - (map.x + map.width / 2), box.y + box.height / 2 - (map.y + map.height / 2));
  // Asked again until Leaflet's zoom has settled.
  await expect.poll(async () => offCentre((await line.boundingBox())!)).toBeLessThan(3);
  const zoomed = (await line.boundingBox())!;
  expect(zoomed.x).toBeGreaterThanOrEqual(map.x - 1);
  expect(zoomed.x + zoomed.width).toBeLessThanOrEqual(map.x + map.width + 1);
  expect(zoomed.y).toBeGreaterThanOrEqual(map.y - 1);
  expect(zoomed.y + zoomed.height).toBeLessThanOrEqual(map.y + map.height + 1);

  // Selecting the journey shows all of it again: centred on the whole journey instead.
  await journeys(page).nth(1).locator("h2").click();
  await expect.poll(async () => offCentre((await line.boundingBox())!)).toBeGreaterThan(20);
});

test("draws a cancelled ride faded, and the way on without it", async ({ page }) => {
  await answerWith(page, (body) => {
    body.live = "on";
    const direct = body.journeys[0];
    direct.legs[0].canceled = true;
    direct.legs[0].delay = 0;
    const wayOn = structuredClone(body.journeys[1]);
    wayOn.legs[2].path = [[50.0101, 14.001], [50.02, 14.3], [50.03, 14.0]]; // a detour east, off the bus's route
    direct.fallback = { leg: 0, reason: "canceled", from: direct.legs[0].from, at: "08:05", journey: wayOn, later: -15 };
  });
  await page.goto(search);
  const canceled = page.locator("path.canceled-leg");
  await expect(canceled).toHaveCount(1);
  await expect(canceled).toHaveAttribute("stroke-opacity", "0.35");
  // The way on: tram 1, the walk, bus 200; dots where the two rides are boarded.
  await expect(page.locator("path.fallback-leg")).toHaveCount(3);
  await expect(page.locator('path.fallback-leg[stroke-dasharray="1 7"]')).toHaveCount(1); // the walk
  await expect(page.locator("path.fallback-stop")).toHaveCount(2);
  // The map fits the way on too, its detour included. Asked again until Leaflet's zoom has
  // settled: a fixed wait read the lines mid-animation on a busy machine.
  const outside = async () => {
    const map = (await page.locator("#map").boundingBox())!;
    const out = [];
    for (const path of await page.locator("path.fallback-leg").all()) {
      const box = (await path.boundingBox())!;
      if (box.x < map.x - 1 || box.y < map.y - 1 || box.x + box.width > map.x + map.width + 1 || box.y + box.height > map.y + map.height + 1)
        out.push(box);
    }
    return out;
  };
  await expect.poll(outside).toEqual([]);
  await canceled.dispatchEvent("mouseover");
  await expect(page.locator(".leaflet-tooltip")).toHaveText("bus 300 (canceled)");
});

test("no 'Show on map' when nothing goes on", async ({ page }) => {
  await answerWith(page, (body) => {
    body.live = "on";
    body.journeys[1].legs[2].changeAtRisk = true;
    body.journeys[1].fallback = { leg: 2, from: body.journeys[1].legs[0].to, at: "08:30", journey: null, later: null };
  });
  await page.goto(search);
  await expect(page.locator(".fallback")).toBeVisible();
  await expect(page.getByRole("button", { name: "Show on map" })).toHaveCount(0);
  await journeys(page).nth(1).click();
  await expect(page.locator("path.fallback-leg")).toHaveCount(0);
});

test("marks the change at risk on the map, naming the late vehicle", async ({ page }) => {
  await answerWith(page, missedAtBravo);
  await page.goto(search);
  await expect(page.locator("path.risk-stop, path.risk-halo")).toHaveCount(0); // the direct one is fine

  await journeys(page).nth(1).click();
  const ring = page.locator("path.risk-stop");
  await expect(ring).toHaveCount(1);
  await expect(page.locator("path.risk-halo")).toHaveCount(1);
  // Drawn last, over every line and dot, so nothing hides it.
  await expect(drawn(page).last()).toHaveClass(/risk-stop/);
  // Red from the stylesheet (--error), not Leaflet's blue default.
  await expect(ring).toHaveCSS("stroke", "rgb(180, 35, 24)");
  await ring.dispatchEvent("mouseover");
  await expect(page.locator(".leaflet-tooltip")).toHaveText("08:08 Bravo (2) · this change may be missed: tram 1 is +2 min late");
  // Where the bus is boarded, which is where the way on starts too.
  // (Asked again until the map's zoom has settled.)
  const apart = async () => {
    const box = (await ring.boundingBox())!;
    const wayOn = (await page.locator("path.fallback-stop").boundingBox())!;
    return Math.hypot(box.x + box.width / 2 - (wayOn.x + wayOn.width / 2), box.y + box.height / 2 - (wayOn.y + wayOn.height / 2));
  };
  await expect.poll(apart).toBeLessThan(1);

  await journeys(page).nth(0).click();
  await expect(page.locator("path.risk-stop, path.risk-halo")).toHaveCount(0);
});

test("marks a cancelled ride on the map, and says only that when its change is at risk too", async ({ page }) => {
  await answerWith(page, (body) => {
    body.live = "on";
    body.journeys[0].legs[0].canceled = true;
    body.journeys[0].legs[0].delay = 0;
    body.journeys[0].legs[0].changeAtRisk = true;
  });
  await page.goto(search);
  const ring = page.locator("path.risk-stop");
  await expect(ring).toHaveCount(1);
  await ring.dispatchEvent("mouseover");
  await expect(page.locator(".leaflet-tooltip")).toHaveText("08:05 Alpha · bus 300 is canceled");
});

test("a change at risk with no delay to name still says why", async ({ page }) => {
  await answerWith(page, (body) => {
    body.live = "on";
    body.journeys[1].legs[0].delay = 20; // on time by the minute: not the one to blame
    body.journeys[1].legs[2].changeAtRisk = true;
  });
  await page.goto(search);
  await journeys(page).nth(1).click();
  const ring = page.locator("path.risk-stop");
  await ring.dispatchEvent("mouseover");
  await expect(page.locator(".leaflet-tooltip")).toHaveText("08:08 Bravo (2) · this change may be missed: the vehicle before is late");
});

test("the warning is in the popup too, for a tap on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await answerWith(page, missedAtBravo);
  await page.goto(search);
  await journeys(page).nth(1).click();
  await page.locator("path.risk-stop").dispatchEvent("click");
  const popup = page.locator(".leaflet-popup-content");
  await expect(popup).toHaveText("This change may be missed: tram 1 is +2 min late08:08 Bravo (2)Departures from here");
  await expect(popup.locator(".risk")).toHaveCSS("color", "rgb(180, 35, 24)");
  // The tooltip sits above the dot and wraps, so it stays on a narrow map.
  await page.locator("path.risk-stop").dispatchEvent("mouseover");
  const tip = (await page.locator(".leaflet-tooltip").boundingBox())!;
  const map = (await page.locator("#map").boundingBox())!;
  expect(tip.x).toBeGreaterThanOrEqual(map.x);
  expect(tip.x + tip.width).toBeLessThanOrEqual(map.x + map.width);
});

/**
 * The map's zoom level once it has stopped moving. Leaflet keeps it in its "proxy" element,
 * scaled by 2^(zoom - 1), and updates it at the end of every move.
 */
const mapZoom = (page: import("@playwright/test").Page) =>
  page.locator(".leaflet-proxy").evaluate((proxy) => {
    const scale = Number(/scale\(([\d.e+-]+)\)/.exec((proxy as HTMLElement).style.transform)?.[1]);
    return Math.round(Math.log2(scale) + 1);
  });

/** Waits two frames: the map buttons move the map on the next one (see whenStill in app.js). */
const frames = (page: import("@playwright/test").Page) =>
  page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

/** How far a box's centre is from the map's centre, in pixels. */
async function offMapCentre(page: import("@playwright/test").Page, box: { x: number; y: number; width: number; height: number }) {
  const map = (await page.locator("#map").boundingBox())!;
  return Math.hypot(box.x + box.width / 2 - (map.x + map.width / 2), box.y + box.height / 2 - (map.y + map.height / 2));
}

test("'Show stop on map' under a change at risk zooms to its ring and opens the warning", async ({ page }) => {
  await answerWith(page, missedAtBravo);
  await page.goto(search);
  await expect(journeys(page).nth(0)).toHaveAttribute("aria-selected", "true");
  const button = journeys(page).nth(1).locator(".risk").getByRole("button", { name: "Show stop on map" });
  await button.click();
  await expect(journeys(page).nth(1)).toHaveAttribute("aria-selected", "true");
  const ring = page.locator("path.risk-stop");
  await expect(ring).toHaveCount(1);
  // Close in on the stop (street level), centred on the ring, its popup open.
  await expect.poll(() => mapZoom(page)).toBe(17);
  await expect.poll(async () => offMapCentre(page, (await ring.boundingBox())!)).toBeLessThan(3);
  await expect(page.locator(".leaflet-popup-content")).toHaveText(
    "This change may be missed: tram 1 is +2 min late08:08 Bravo (2)Departures from here",
  );
  // The way on keeps its own button, which still shows the whole way on.
  await expect(journeys(page).nth(1).getByRole("button", { name: "Show on map", exact: true })).toHaveCount(1);
});

test("'Show stop on map' under a cancelled ride, from the keyboard", async ({ page }) => {
  await answerWith(page, (body) => {
    body.live = "on";
    body.journeys[1].legs[2].canceled = true;
    body.journeys[1].legs[2].delay = 0;
  });
  await page.goto(search);
  const risk = journeys(page).nth(1).locator(".risk");
  await expect(risk).toHaveText("bus 200 at 08:08 is canceled Show stop on map");
  await expect(risk).toHaveCSS("font-weight", "600");
  const button = risk.getByRole("button", { name: "Show stop on map" });
  await expect(button).toHaveCSS("font-weight", "400"); // a control under the warning, not part of it
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(journeys(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".leaflet-popup-content")).toHaveText("Bus 200 is canceled08:08 Bravo (2)Departures from here");
  await expect.poll(() => mapZoom(page)).toBe(17);
  await expect(button).toBeFocused(); // the list keeps its place for the next key
});

test("'Show stop on map' doesn't zoom out of a closer view", async ({ page }) => {
  // Without animations the map is where it ends up a frame after the click, so a wrong zoom
  // on the way can't pass for the right one.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await answerWith(page, missedAtBravo);
  await page.goto(search);
  const button = journeys(page).nth(1).locator(".risk").getByRole("button", { name: "Show stop on map" });
  await button.click();
  await frames(page);
  expect(await mapZoom(page)).toBe(17);
  await page.locator("#map").getByRole("button", { name: "Zoom in" }).click(); // Leaflet's own, animated
  await expect.poll(() => mapZoom(page)).toBe(18);
  await expect(page.locator(".leaflet-map-pane")).not.toHaveClass(/leaflet-zoom-anim/);
  await button.click();
  await frames(page);
  expect(await mapZoom(page)).toBe(18);
  const ring = page.locator("path.risk-stop");
  expect(await offMapCentre(page, (await ring.boundingBox())!)).toBeLessThan(3);
});

test("with reduced motion, the map jumps to the stop at once", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await answerWith(page, missedAtBravo);
  await page.goto(search);
  await expect(page.locator("path.risk-stop")).toHaveCount(0);
  await journeys(page).nth(1).locator(".risk").getByRole("button", { name: "Show stop on map" }).click();
  // No animation to wait for: read a frame later, not asked again until it gets there.
  await frames(page);
  const ring = page.locator("path.risk-stop");
  expect(await offMapCentre(page, (await ring.boundingBox())!)).toBeLessThan(3);
  // Selecting a journey jumps to all of it too: no zoom animation running a few frames later.
  await journeys(page).nth(0).locator("h2").click();
  await frames(page);
  expect(await mapZoom(page)).toBeLessThan(17);
  expect(await page.locator(".leaflet-map-pane").evaluate((pane) => pane.classList.contains("leaflet-zoom-anim"))).toBe(false);
});

test("on a phone, 'Show stop on map' brings the map into view", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 640 });
  await answerWith(page, missedAtBravo);
  await page.goto(search);
  await expect(page.locator("#map")).not.toBeInViewport();
  await journeys(page).nth(1).locator(".risk").getByRole("button", { name: "Show stop on map" }).click();
  // All of it, not the edge a click on the button scrolls into view with it.
  await expect(page.locator("#map")).toBeInViewport({ ratio: 0.9 });
  await expect(page.locator(".leaflet-popup-content")).toBeVisible();
});

// Selecting another journey used to fit the map to all of it first, with an animated zoom, and
// Leaflet ignores a zoom asked for during one: the map stayed on the whole journey.
test("both map buttons move the map even when it has to zoom to another journey first", async ({ page }) => {
  await answerWith(page, missedAtBravo);
  await page.goto(search);
  const zoomIn = page.locator("#map").getByRole("button", { name: "Zoom in" });
  const settle = async (zoom: number) => {
    await expect.poll(() => mapZoom(page)).toBe(zoom);
    await expect(page.locator(".leaflet-map-pane")).not.toHaveClass(/leaflet-zoom-anim/);
  };
  /** The zoom once the map has stayed put for a moment (after a search or a click on a journey). */
  const stillZoom = async () => {
    let zoom = NaN;
    await expect
      .poll(async () => {
        const before = await mapZoom(page);
        await page.waitForTimeout(300);
        zoom = await mapZoom(page);
        const zooming = await page.locator(".leaflet-map-pane").evaluate((pane) => pane.classList.contains("leaflet-zoom-anim"));
        return before === zoom && !zooming;
      })
      .toBe(true);
    return zoom;
  };
  // Journey 1 is shown, zoomed in on it: journey 2 would fit at another zoom.
  await expect(drawn(page)).toHaveCount(4);
  const start = await stillZoom();
  await zoomIn.click();
  await settle(start + 1);

  await journeys(page).nth(1).locator(".risk").getByRole("button", { name: "Show stop on map" }).click();
  await settle(17);
  const ring = page.locator("path.risk-stop");
  await expect.poll(async () => offMapCentre(page, (await ring.boundingBox())!)).toBeLessThan(3);

  // Back to journey 1, zoomed in on it, then the way on of journey 2.
  await journeys(page).nth(0).locator("h2").click();
  await expect.poll(() => mapZoom(page)).not.toBe(17);
  const fitted = await stillZoom();
  await zoomIn.click();
  await settle(fitted + 1);
  await journeys(page).nth(1).getByRole("button", { name: "Show on map", exact: true }).click();
  const line = page.locator("path.fallback-leg");
  await expect.poll(async () => offMapCentre(page, (await line.boundingBox())!)).toBeLessThan(3);
});

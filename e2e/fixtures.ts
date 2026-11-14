/**
 * The page under test without the internet: Leaflet comes from node_modules instead of cdnjs
 * (the page's subresource integrity hashes check it is the same file), map tiles are a blank
 * image instead of OpenStreetMap's servers, and any other outside request fails the test.
 * Console errors and uncaught exceptions fail it too.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test as base } from "@playwright/test";

const LEAFLET = join(import.meta.dirname, "..", "node_modules", "leaflet", "dist");
const CDN = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/";
// A 1x1 transparent PNG.
const BLANK_TILE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

export const test = base.extend<{ problems: string[] }>({
  problems: [
    async ({ page }, use) => {
      const problems: string[] = [];
      // A 400 from the API is an answer the page shows (an unknown stop); the browser still logs it.
      const answered = new Set<string>();
      page.on("response", (response) => {
        if (response.status() === 400 && new URL(response.url()).pathname === "/api/plan") answered.add(response.url());
      });
      page.on("console", (message) => {
        if (message.type() !== "error") return;
        const expected = /status of 400/.test(message.text()) && answered.has(message.location().url);
        if (!expected) problems.push(`console: ${message.text()}`);
      });
      page.on("pageerror", (error) => problems.push(`exception: ${error.message}`));

      await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, async (route) => {
        const url = route.request().url();
        const cors = { "access-control-allow-origin": "*" }; // the page loads Leaflet with crossorigin
        if (url === `${CDN}leaflet.js`) {
          return route.fulfill({ body: readFileSync(join(LEAFLET, "leaflet.js")), contentType: "text/javascript", headers: cors });
        }
        if (url === `${CDN}leaflet.css`) {
          return route.fulfill({ body: readFileSync(join(LEAFLET, "leaflet.css")), contentType: "text/css", headers: cors });
        }
        if (url.startsWith("https://tile.openstreetmap.org/")) {
          return route.fulfill({ body: BLANK_TILE, contentType: "image/png" });
        }
        if (url.startsWith(CDN)) return route.fulfill({ status: 404 }); // Leaflet's marker images
        problems.push(`outside request: ${url}`);
        return route.abort();
      });

      await use(problems);
      expect(problems, "console errors, exceptions or outside requests").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** The page's address for a search: the page runs it as soon as it loads. */
export function searchUrl(params: Record<string, string>): string {
  return `/?${new URLSearchParams(params)}`;
}

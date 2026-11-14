/**
 * Browser tests for the web page (e2e/*.e2e.ts), against the real server on the test feed.
 *
 * Run with `npm run test:e2e` (builds first). Playwright's own Chromium is used unless
 * PLAYWRIGHT_CHANNEL names an installed browser (e.g. "msedge" or "chrome"), which saves the
 * download: `npx playwright install chromium` fetches it otherwise.
 */
import { defineConfig, devices } from "@playwright/test";

const PORT = 8097;
const channel = process.env.PLAYWRIGHT_CHANNEL || undefined;

export default defineConfig({
  testDir: "e2e",
  testMatch: "*.e2e.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    ...(channel ? { channel } : {}),
  },
  webServer: {
    // The built CLI, as a user runs it; --no-cache keeps the fixture folder clean.
    command: `node dist/bin.js serve --gtfs tests/fixtures/mini --port ${PORT} --no-cache`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});

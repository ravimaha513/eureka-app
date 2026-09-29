import { defineConfig } from "@playwright/test";
/**
 * End-to-end journeys per role against a running stack (API + web + seeded DB).
 * Start the stack first (see README); in CI this runs nightly against staging.
 */
export default defineConfig({
  testDir: "e2e",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5173",
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
    screenshot: "only-on-failure",
  },
});

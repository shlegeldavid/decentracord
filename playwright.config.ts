import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 5_000 },
  reporter: "line",
  outputDir: "/tmp/decentracord-playwright-results",
  use: {
    baseURL: process.env.TEST_ORIGIN ?? process.env.E2E_BASE_URL ?? "http://decentracord.test:3000",
    browserName: "chromium",
    trace: "retain-on-failure"
  }
});

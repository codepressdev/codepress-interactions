import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  use: {
    ...devices["Desktop Chrome"], // 1280x720
    baseURL: "http://localhost:5173",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    // Use the dev server you already have running, if any.
    reuseExistingServer: !process.env.CI,
  },
});

import { defineConfig, devices } from "@playwright/test";

// Real-browser tests. Pages are served from memory over https (page.route), so
// they are secure contexts with crypto.subtle and CompressionStream.
export default defineConfig({
  testDir: "test/e2e",
  testMatch: "*.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});

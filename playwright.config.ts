import { defineConfig, devices } from "@playwright/test";

const PORT = 3300;

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  retries: 0,
  workers: 1, // tests share one server and database; approvals change flag state
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    timeout: 180_000,
    reuseExistingServer: false,
    env: { PGLITE_DIR: ".data/e2e", ANTHROPIC_API_KEY: "", START_RATE_LIMIT: "100" },
  },
});

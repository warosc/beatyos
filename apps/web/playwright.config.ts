import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 3012);
const baseURL = `http://127.0.0.1:${port}`;
const distDir = process.env.E2E_NEXT_DIST_DIR ?? 'next-e2e';

export default defineConfig({
  testDir: './e2e',
  outputDir: process.env.E2E_OUTPUT_DIR ?? 'test-results',
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: 'html',
  use: { baseURL, trace: 'on-first-retry' },
  webServer: {
    command: `npm exec -- next dev -p ${port}`,
    env: { NEXT_DIST_DIR: distDir },
    url: baseURL,
    reuseExistingServer: false,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'ipad', use: { ...devices['iPad Pro 11'] } },
  ],
});

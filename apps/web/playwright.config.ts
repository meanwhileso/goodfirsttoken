import { defineConfig, devices } from '@playwright/test';

// End-to-end tests run against the production build, served by Vite preview
// inside the Workers runtime. Locally, a preview server you already started
// is reused.
export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm build && pnpm preview',
    url: 'http://localhost:4173/healthz',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});

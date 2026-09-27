import { defineConfig } from '@playwright/test'
import { E2E_UI_PORT } from './e2e/ports'

/**
 * End-to-end tests of the HUD in Chromium against the real bridge and Vite,
 * with a scripted agent in place of Claude (e2e/serve.ts).
 *
 *   npm run test:e2e
 *
 * Needs Playwright's Chromium: `npx playwright install chromium` once.
 */
export default defineConfig({
  testDir: 'e2e',
  // *.e2e.ts, so Vitest's default *.test/*.spec pattern leaves them alone.
  testMatch: '**/*.e2e.ts',
  // One harness, one bridge: run serially so sessions and timings stay simple.
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: `http://localhost:${E2E_UI_PORT}`,
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx tsx e2e/serve.ts',
    url: `http://127.0.0.1:${E2E_UI_PORT}/`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' }, grepInvert: /@no-webgl/ },
    {
      name: 'no-webgl',
      use: { browserName: 'chromium', launchOptions: { args: ['--disable-webgl', '--disable-3d-apis'] } },
      grep: /@no-webgl/,
    },
  ],
})

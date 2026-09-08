import { defineConfig, devices } from '@playwright/test';

/**
 * PRD §21 acceptance walk. No `webServer`: the stack is assumed running (see
 * README.md in this folder), so this stays a test and not an orchestrator.
 * Not run in CI — it needs a real answer provider.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  outputDir: './test-results',
  // One ordered scenario: never parallel, one worker.
  fullyParallel: false,
  workers: 1,
  // A retry re-runs the whole serial group with a fresh account; the trace of
  // that second attempt is what gets kept.
  retries: 1,
  // Ingestion and answers are the slow steps; each test also polls explicitly.
  timeout: 240_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['html', { outputFolder: './playwright-report', open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    acceptDownloads: true,
    // Below 1280 px the assistant opens a citation as a route (the reader page)
    // rather than a side pane, which is the navigation §21 asks to see.
    viewport: { width: 1200, height: 900 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1200, height: 900 } } }],
});

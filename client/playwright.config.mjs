import { defineConfig } from '@playwright/test';

// Browser tests of wds-ui.js: they load a pinless test build of the bundle (test-results/bundle, see test/global-setup.mjs) from a file:// page and talk to the in-memory
// fake of the datastore API over HTTP (test/ui-server.mjs). Chromium only; WebKit/Firefox builds are not installed here.
export default defineConfig({
  testDir: './test',
  testMatch: ['ui.spec.mjs', 'ui-visual.spec.mjs', 'ui-store.spec.mjs', 'ui-attrs.spec.mjs'], // integration.spec.mjs has its own config (playwright.integration.config.mjs)
  timeout: 90000,
  expect: { timeout: 15000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  outputDir: './test-results/pw',
  globalSetup: './test/global-setup.mjs',
  use: { browserName: 'chromium', headless: true, locale: 'en-US', acceptDownloads: true, viewport: { width: 1100, height: 800 } },
});

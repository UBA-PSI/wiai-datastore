import { defineConfig } from '../client/node_modules/@playwright/test/index.mjs';

// Browser tests of the example apps (scripts/test-examples.sh). Chromium by default; WDS_BROWSERS=chromium,firefox,webkit runs more engines.
const wanted = (process.env.WDS_BROWSERS || 'chromium').split(',').map((s) => s.trim()).filter(Boolean);

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.mjs',
  timeout: 240000,
  expect: { timeout: 20000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  outputDir: '../client/test-results/pw-examples',
  projects: wanted.map((name) => ({ name, use: { browserName: name } })),
  use: { headless: true, acceptDownloads: true },
});

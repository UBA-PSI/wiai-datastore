import { defineConfig } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, firefox, webkit } from '@playwright/test';

// The WebKit build that Playwright expects is often not the one that is installed. WDS_WEBKIT_EXECUTABLE names a pw_run.sh explicitly;
// otherwise any installed webkit-* build is used as a fallback (an older build may or may not speak this Playwright's protocol).
function webkitFallback() {
  if (process.env.WDS_WEBKIT_EXECUTABLE) return process.env.WDS_WEBKIT_EXECUTABLE;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, join(homedir(), 'Library', 'Caches', 'ms-playwright'), join(homedir(), '.cache', 'ms-playwright')].filter(Boolean);
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const dirs = readdirSync(root).filter((d) => /^webkit-\d+$/.test(d)).sort().reverse();
    for (const d of dirs) if (existsSync(join(root, d, 'pw_run.sh'))) return join(root, d, 'pw_run.sh');
  }
  return null;
}

// Integration tests against the REAL server (test/integration.spec.mjs, scripts/test-integration.sh).
// One project per browser engine. A project whose browser is not installed is left out (and reported), unless the engine is named
// explicitly in WDS_BROWSERS (comma separated: chromium,firefox,webkit), in which case a missing browser is an error.
// Install the others with: npx playwright install firefox webkit
const engines = { chromium, firefox, webkit };
const wanted = process.env.WDS_BROWSERS ? process.env.WDS_BROWSERS.split(',').map((s) => s.trim()).filter(Boolean) : null;
const projects = [];
for (const [name, type] of Object.entries(engines)) {
  if (wanted && !wanted.includes(name)) continue;
  let installed = false;
  try { installed = existsSync(type.executablePath()); } catch (e) { installed = false; }
  const use = { browserName: name };
  if (name === 'webkit' && !installed) {
    const fb = webkitFallback();
    if (fb) { console.warn('integration tests: using the WebKit build at ' + fb + ' (not the one this Playwright version expects)'); use.launchOptions = { executablePath: fb }; installed = true; }
  }
  if (!installed && !wanted) { console.warn('integration tests: skipping ' + name + ' (browser not installed; npx playwright install ' + name + ')'); continue; }
  projects.push({ name, use });
}
if (!projects.length) throw new Error('no browser available for the integration tests');

export default defineConfig({
  testDir: './test',
  testMatch: ['integration.spec.mjs', 'docs.spec.mjs', 'migrate.spec.mjs'],
  timeout: 240000,
  expect: { timeout: 20000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  outputDir: './test-results/pw-integration',
  projects,
  use: { headless: true, locale: 'en-US', acceptDownloads: true, viewport: { width: 1100, height: 800 } },
});

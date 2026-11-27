// Playwright global setup: build the bundle the browser tests load. It is a separate build without escrow pins (a bundle
// with pins ignores the escrowPins option, which the tests need), written to test-results/bundle so that it never replaces
// the production bundle in dist/.
import { fileURLToPath } from 'node:url';
import { build } from '../build.mjs';

export const TEST_BUNDLE_DIR = fileURLToPath(new URL('../test-results/bundle', import.meta.url));

export default async function globalSetup() {
  const r = build({ allowAnyPinCount: true, escrowPins: [], retiredEscrow: [], dist: TEST_BUNDLE_DIR, testHooks: true });
  console.log('bundle for browser tests: ' + r.file + ' (' + r.sri + ')');
}

// Shared setup for the e2e scripts.
//
// Branded Google Chrome ignores --load-extension (since Chrome 137), so the
// tests need Chrome for Testing. Install it with:
//   npx @puppeteer/browsers install chrome@stable --path ~/.cache/puppeteer
// or point CHROME_PATH at any Chromium build that still accepts --load-extension.
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The built extension. Override with DIST to test another build. */
export const dist = process.env.DIST ?? path.resolve(import.meta.dirname, '../dist');

export function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = path.join(os.homedir(), '.cache/puppeteer/chrome');
  const builds = existsSync(root) ? readdirSync(root).sort().reverse() : [];
  for (const build of builds) {
    for (const exe of [
      'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-linux64/chrome',
    ]) {
      const p = path.join(root, build, exe);
      if (existsSync(p)) return p;
    }
  }
  throw new Error('Chrome for Testing not found. Run `npx @puppeteer/browsers install chrome@stable --path ~/.cache/puppeteer` or set CHROME_PATH.');
}

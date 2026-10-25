// Restart test: sync some windows, quit, relaunch with session restore, and
// check the extension re-recognizes live tabs without duplicating anything.
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { chromePath as findChrome, dist } from './chrome.mjs';

const chromePath = findChrome();
const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(`<title>Page ${req.url.slice(1)}</title>`); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const P = (n) => `${base}/${n}`;
const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'tabsync-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const launch = (extra = []) => puppeteer.launch({
  executablePath: chromePath, headless: true, userDataDir, protocolTimeout: 20000,
  targetFilter: (t) => !t.url().startsWith('data:'),
  ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--no-first-run', `--disable-extensions-except=${dist}`, `--load-extension=${dist}`, ...extra],
});
const state = (sw) => sw.evaluate(async () => {
  const parse = (u) => {
    if (!u.startsWith('data:text/html')) return null;
    const html = decodeURIComponent(u.slice(u.indexOf(',') + 1));
    return html.startsWith('<!--tabsync?') ? new URLSearchParams(html.slice(12, html.indexOf('-->'))) : null;
  };
  const ws = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  return ws.map((w) => w.tabs.map((t) => { const u = t.url || t.pendingUrl || ''; const g = parse(u); return { ghost: !!g, url: g ? g.get('u') : u }; }));
});
const summary = (s) => s.map((w) => w.filter((t) => t.url.startsWith(base)).map((t) => `${t.ghost ? '~' : ''}${t.url.slice(base.length + 1)}`).join(',')).sort().join(' | ');
const seqs = (s) => s.map((w) => w.filter((t) => t.url.startsWith(base)).map((t) => t.url.slice(base.length + 1)).join(','));
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); };

try {
  let browser = await launch();
  let sw = await (await browser.waitForTarget((t) => t.type() === 'service_worker')).worker();
  const [first] = await browser.pages();
  await first.goto(P('a'));
  await (await browser.newPage()).goto(P('b'));
  await sw.evaluate((u) => chrome.windows.create({ url: u, focused: false }), P('c'));
  await sleep(3000);
  const before = await state(sw);
  console.log('before :', summary(before));
  await browser.close();

  browser = await launch(['--restore-last-session']);
  sw = await (await browser.waitForTarget((t) => t.type() === 'service_worker')).worker();
  await sleep(5000);
  const after = await state(sw);
  console.log('after  :', summary(after));
  const s = seqs(after);
  check('windows still show the same tabs in the same order', s.length === 2 && s.every((x) => x === s[0]) && s[0] === 'a,b,c', s.join(' | '));
  const live = after.flat().filter((t) => !t.ghost && t.url.startsWith(base)).map((t) => t.url.slice(base.length + 1)).sort();
  check('each page is live exactly once (nothing duplicated or lost)', live.join() === 'a,b,c', live.join());
  check('stand-ins and live tabs are where they were', summary(after) === summary(before));
  await browser.close();
} catch (e) {
  console.error(e);
  check('ran to completion', false, String(e));
} finally {
  server.close();
  await rm(userDataDir, { recursive: true, force: true });
}
process.exit(results.every(Boolean) ? 0 : 1);

// Stress and memory: N tabs (default 40, set N=…) mirrored into two more windows.
// Reports settle time, idle stability and memory per Chrome process type.
// Informational: prints numbers, no pass/fail.
import http from 'node:http';
import { execSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { chromePath as findChrome, dist } from './chrome.mjs';
const chromePath = findChrome();
const N = Number(process.env.N ?? 40);
const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(`<title>Stress ${req.url.slice(1)}</title><p>${'lorem ipsum '.repeat(200)}</p>`); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, protocolTimeout: 60000,
  targetFilter: (t) => !t.url().startsWith('data:'), ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--no-first-run', `--disable-extensions-except=${dist}`, `--load-extension=${dist}`] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pid = browser.process().pid;
const rssMB = () => {
  const lines = execSync(`ps -A -o pid=,ppid=,rss=,command=`).toString().trim().split('\n');
  const out = lines.map((l) => { const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/); return [Number(m[1]), Number(m[2]), Number(m[3]), m[4]]; });
  const kids = new Set([pid]); let grew = true;
  while (grew) { grew = false; for (const [p, pp] of out) if (kids.has(pp) && !kids.has(p)) { kids.add(p); grew = true; } }
  const by = {};
  for (const [p, , r, cmd] of out) {
    if (!kids.has(p)) continue;
    const type = p === pid ? 'browser' : (cmd.match(/--type=([a-z-]+)/)?.[1] ?? 'other') + (cmd.includes('--extension-process') ? '(ext)' : '');
    by[type] = (by[type] ?? 0) + Math.round(r / 1024);
  }
  return { procs: kids.size, mb: by };
};
const sw = await (await browser.waitForTarget((t) => t.type() === 'service_worker')).worker();
const stats = () => sw.evaluate(async () => {
  const tabs = await chrome.tabs.query({});
  const ghosts = tabs.filter((t) => (t.url || t.pendingUrl || '').startsWith('data:text/html'));
  return { tabs: tabs.length, ghosts: ghosts.length, discarded: ghosts.filter((t) => t.discarded).length, windows: (await chrome.windows.getAll()).length };
});
await sw.evaluate(async (base, n) => {
  const [w] = await chrome.windows.getAll();
  for (let i = 0; i < n; i++) await chrome.tabs.create({ windowId: w.id, url: `${base}/${i}`, active: false });
}, base, N);
await sleep(4000);
console.log('1 window,', N, 'tabs:', JSON.stringify(await stats()), JSON.stringify(rssMB()));
const t0 = Date.now();
await sw.evaluate(async () => { await chrome.windows.create({ focused: false }); await chrome.windows.create({ focused: false }); });
let st;
for (;;) {
  await sleep(250);
  st = await stats();
  if (st.ghosts >= 2 * N && st.discarded === st.ghosts) break;
  if (Date.now() - t0 > 60000) break;
}
console.log(`+2 windows: all ${st.ghosts} stand-ins created and unloaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`, JSON.stringify(st));
await sleep(3000);
console.log("settled  :", JSON.stringify(rssMB()));
const a = await stats();
await sleep(10000);
const b = await stats();
console.log('idle 10s : stable =', JSON.stringify(a) === JSON.stringify(b), JSON.stringify(b), JSON.stringify(rssMB()));
const swHeap = await sw.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
console.log('service worker JS heap:', swHeap ? `${(swHeap / 1e6).toFixed(1)} MB` : 'n/a');
const t1 = Date.now();
await sw.evaluate(async (base) => { const [w] = await chrome.windows.getAll(); await chrome.tabs.create({ windowId: w.id, url: `${base}/new`, active: false }); }, base);
for (;;) { await sleep(100); const s = await stats(); if (s.ghosts === 2 * N + 2 || Date.now() - t1 > 10000) break; }
console.log(`one new tab mirrored to 2 windows in ${((Date.now() - t1) / 1000).toFixed(2)}s (incl. page load)`);
await browser.close(); server.close();

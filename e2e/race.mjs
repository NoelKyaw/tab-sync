// Race test: open stand-ins while their live tab is being closed or moved at the
// same moment. The extension must not report errors and windows must converge.
import http from 'node:http';
import puppeteer from 'puppeteer-core';
import { chromePath as findChrome, dist } from './chrome.mjs';
const chromePath = findChrome();
const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(`<title>Page ${req.url.slice(1)}</title>`); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, protocolTimeout: 30000,
  targetFilter: (t) => !t.url().startsWith('data:'), ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--no-first-run', `--disable-extensions-except=${dist}`, `--load-extension=${dist}`] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sw = await (await browser.waitForTarget((t) => t.type() === 'service_worker')).worker();
const errors = [];
sw.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const N = 12;
await sw.evaluate(async (base, n) => {
  const [w] = await chrome.windows.getAll();
  for (let i = 0; i < n; i++) await chrome.tabs.create({ windowId: w.id, url: `${base}/p${i}`, active: false });
  await chrome.windows.create({ focused: true });
}, base, N);
await sleep(3000);
const w1 = await sw.evaluate(async () => (await chrome.windows.getAll()).find((w) => !w.focused)?.id ?? (await chrome.windows.getAll())[0].id);
let rounds = 0;
for (let i = 0; i < 32; i++) {
  const ok = await sw.evaluate(async (base, i, w1) => {
    const isGhost = (t) => (t.url || t.pendingUrl || '').startsWith('data:text/html');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const url = `${base}/r${i}`;
    const live = await chrome.tabs.create({ windowId: w1, url, active: false });
    // Wait for its stand-in in the other window.
    let ghost;
    for (let k = 0; k < 40 && !ghost; k++) {
      await sleep(100);
      ghost = (await chrome.tabs.query({})).find((t) => isGhost(t) && t.windowId !== w1 && decodeURIComponent(t.url).includes(url));
    }
    if (!ghost) return false;
    chrome.tabs.update(ghost.id, { active: true }).catch(() => {});
    const delay = i % 16;
    setTimeout(() => (i % 2 ? chrome.tabs.remove(live.id) : chrome.tabs.remove(ghost.id)).catch(() => {}), delay);
    await sleep(400);
    return true;
  }, base, i, w1);
  if (ok) rounds++;
}
await sleep(4000);
const state = await sw.evaluate(async () => {
  const isGhost = (t) => (t.url || t.pendingUrl || '').startsWith('data:text/html');
  const ws = await chrome.windows.getAll({ populate: true });
  const key = (t) => (isGhost(t) ? decodeURIComponent(t.url.slice(t.url.indexOf(',') + 1)).match(/u=([^&]+)/)[1] : encodeURIComponent(t.url));
  return ws.map((w) => w.tabs.filter((t) => !t.pinned && (isGhost(t) || t.url.startsWith('http'))).map((t) => decodeURIComponent(key(t)).split('/').pop()).join(','));
});
const same = state.every((s) => s === state[0]);
console.log(`${rounds} racy rounds; windows: ${state.join(' | ')}`);
console.log(`${same ? 'PASS' : 'FAIL'}  windows converge to the same tabs`);
console.log(`${errors.length === 0 ? 'PASS' : 'FAIL'}  no extension errors${errors.length ? `: ${[...new Set(errors)].slice(0, 3).join(' / ')}` : ''}`);
await browser.close(); server.close();
process.exit(same && errors.length === 0 ? 0 : 1);

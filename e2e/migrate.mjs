// Upgrade test: a profile left in v0.2's state (pinned tabs copied into other
// windows) is cleaned up by v0.3 after a restart, without touching real tabs.
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { chromePath as findChrome, dist } from './chrome.mjs';
import { ghostUrl } from '../src/sync/model.ts';

const chromePath = findChrome();
const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(`<title>Page ${req.url.slice(1)}</title>`); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const P = (n) => `${base}/${n}`;
const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'tabsync-mig-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const launch = (extra = []) => puppeteer.launch({
  executablePath: chromePath, headless: true, userDataDir, protocolTimeout: 20000,
  targetFilter: (t) => !t.url().startsWith('data:'), ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--no-first-run', `--disable-extensions-except=${dist}`, `--load-extension=${dist}`, ...extra],
});
const getSw = async (b) => (await b.waitForTarget((t) => t.type() === 'service_worker')).worker();
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); };
const describe = (sw) => sw.evaluate(async () => {
  const ws = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  return ws.map((w) => w.tabs.map((t) => {
    const u = t.url || t.pendingUrl || '';
    const html = u.startsWith('data:text/html') ? decodeURIComponent(u.slice(u.indexOf(',') + 1)) : '';
    const g = html.startsWith('<!--tabsync?') ? new URLSearchParams(html.slice(12, html.indexOf('-->'))) : null;
    const url = g ? g.get('u') : u;
    return `${t.pinned ? '*' : ''}${g ? '~' : ''}${url.split('/').pop()}`;
  }).filter((x) => !x.endsWith('newtab')).join(','));
});

try {
  // 1. Pause sync and leave v0.2-shaped saved state behind.
  let browser = await launch();
  let sw = await getSw(browser);
  const e = (n) => ({ url: P(n), title: `Page ${n}` });
  await sw.evaluate((saved) => chrome.storage.local.set({ enabled: false, saved }), {
    order: ['mail', 'docs', 'a'],
    entries: { mail: { ...e('mail'), pinned: true }, docs: { ...e('docs'), pinned: false }, a: { ...e('a'), pinned: false } },
  });
  await browser.close();

  // 2. With sync paused, lay out what v0.2 left: window 1 has the real pinned tabs, window 2 has copies.
  browser = await launch();
  sw = await getSw(browser);
  await sw.evaluate(async (tabs1, tabs2) => {
    const [w1] = await chrome.windows.getAll();
    for (const t of tabs1) await chrome.tabs.create({ windowId: w1.id, ...t, active: false });
    const w2 = await chrome.windows.create({ url: tabs2[0].url, focused: false });
    await chrome.tabs.update(w2.tabs[0].id, { pinned: true });
    for (const t of tabs2.slice(1)) await chrome.tabs.create({ windowId: w2.id, ...t, active: false });
    await chrome.storage.local.set({ enabled: true });
  },
  [{ url: P('mail'), pinned: true }, { url: P('docs'), pinned: true }, { url: P('a') }],
  [{ url: ghostUrl('mail', e('mail')) }, { url: ghostUrl('docs', e('docs')) }, { url: ghostUrl('a', e('a')) }]);
  await sleep(1500);
  console.log('v0.2 leftovers :', (await describe(sw)).join(' | '));
  await browser.close();

  // 3. Restart with v0.3 enabled.
  browser = await launch(['--restore-last-session']);
  sw = await getSw(browser);
  await sleep(5000);
  const after = await describe(sw);
  console.log('after upgrade  :', after.join(' | '));
  const all = after.join(',').split(',');
  check('copies of pinned tabs are gone', !all.includes('*~mail') && !all.includes('~docs') && !all.includes('~mail'));
  check("the real pinned tabs are untouched", all.filter((x) => x === '*mail').length === 1 && all.filter((x) => x === '*docs').length === 1);
  check('regular tabs keep syncing', all.filter((x) => x === 'a').length === 1 && all.filter((x) => x === '~a').length === 1);
  await browser.close();
} catch (err) {
  console.error(err);
  check('ran to completion', false, String(err));
} finally {
  server.close();
  await rm(userDataDir, { recursive: true, force: true });
}
process.exit(results.every(Boolean) ? 0 : 1);

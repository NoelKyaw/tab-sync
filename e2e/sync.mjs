// Main e2e: load dist/ into Chrome for Testing and drive real windows (mirroring,
// swaps, pinning, closing tabs and windows, new windows, navigation, dragging).
import http from 'node:http';
import puppeteer from 'puppeteer-core';
import { chromePath as findChrome, dist } from './chrome.mjs';

const chromePath = findChrome();
const HEADLESS = process.env.HEADFUL ? false : true;

const server = http.createServer((req, res) => {
  const name = req.url.slice(1).split('?')[0];
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<title>Page ${name}</title><h1>${name}</h1><input id=i>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const P = (n) => `${base}/${n}`;

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: HEADLESS,
  protocolTimeout: 20000,
  targetFilter: (t) => !t.url().startsWith('data:'),
  ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--no-first-run', '--window-size=1000,700', `--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker');
  const sw = await swTarget.worker();
  const swErrors = [];
  sw.on('console', (m) => m.type() === 'error' && swErrors.push(m.text()));
  const runner = { sw };
  const run = (fn, ...args) => runner.sw.evaluate(fn, ...args);

  const state = () =>
    run(async () => {
      const parse = (u) => {
        if (!u.startsWith('data:text/html')) return null;
        const html = decodeURIComponent(u.slice(u.indexOf(',') + 1));
        return html.startsWith('<!--tabsync?') ? new URLSearchParams(html.slice(12, html.indexOf('-->'))) : null;
      };
      const ws = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
      return ws.map((w) => ({
        id: w.id,
        focused: w.focused,
        tabs: w.tabs.map((t) => {
          const u = t.url || t.pendingUrl || '';
          const g = parse(u);
          return { id: t.id, ghost: !!g, url: g ? g.get('u') : u, title: t.title, fav: (t.favIconUrl || '').slice(0, 22), pinned: t.pinned, active: t.active, discarded: t.discarded };
        }),
      }));
    });
  // Regular (unpinned) tabs only: pinned tabs are Dia's Favorites/Pinned and aren't synced.
  const synced = (w) => w.tabs.filter((t) => !t.pinned && t.url.startsWith(base)).map((t) => t.url.slice(base.length + 1));
  const pinnedOf = (w) => w.tabs.filter((t) => t.pinned).map((t) => `${t.ghost ? '~' : ''}${t.url.slice(base.length + 1)}`);
  const settle = async (ms = 1500) => sleep(ms);
  const allSame = (s) => {
    const seqs = s.map((w) => synced(w).join(','));
    return { ok: seqs.every((x) => x === seqs[0]), seqs: seqs.join(' | ') };
  };
  const liveCount = (s, n) => s.flatMap((w) => w.tabs).filter((t) => !t.ghost && t.url === P(n)).length;

  // Window 1: a, b. Window 2: c.
  const [first] = await browser.pages();
  await first.goto(P('a'));
  await (await browser.newPage()).goto(P('b'));
  const w2 = await run(async (u) => (await chrome.windows.create({ url: u, focused: false })).id, P('c'));
  await settle(2500);
  let s = await state();
  const w1 = s.find((w) => w.id !== w2).id;
  let same = allSame(s);
  check('every window shows the same tabs in the same order', same.ok && synced(s[0]).length === 3, same.seqs);
  check('each page is live exactly once', ['a', 'b', 'c'].every((n) => liveCount(s, n) === 1));
  const idleGhosts = s.flatMap((w) => w.tabs).filter((t) => t.ghost && !t.active);
  check('hidden stand-ins are unloaded (discarded)', idleGhosts.length > 0 && idleGhosts.every((t) => t.discarded), `${idleGhosts.filter((t) => t.discarded).length}/${idleGhosts.length}`);
  const ghostTitle = s.flatMap((w) => w.tabs).find((t) => t.ghost && t.url === P('c'))?.title;
  check('stand-in shows the real title', ghostTitle === 'Page c', ghostTitle);
  const ghostFav = s.flatMap((w) => w.tabs).find((t) => t.ghost && t.url === P('c'))?.fav;
  check('stand-in shows a favicon', ghostFav?.startsWith('data:image/'), ghostFav);

  // New tab in window 1 appears in window 2.
  await run((w, u) => chrome.tabs.create({ windowId: w, url: u, active: false }), w1, P('d'));
  await settle();
  s = await state();
  same = allSame(s);
  check('a new tab shows up in every window', same.ok && synced(s[0]).includes('d'), same.seqs);

  // Reorder in window 1.
  await run(async (w, u) => {
    const [t] = await chrome.tabs.query({ windowId: w, url: u });
    await chrome.tabs.move(t.id, { index: 0 });
  }, w1, `${P('d')}*`);
  await settle();
  s = await state();
  same = allSame(s);
  check('reordering is mirrored', same.ok && synced(s[0])[0] === 'd', same.seqs);

  // Pin b in window 1 (drag it into Pinned): it leaves sync, the tab itself stays.
  await run(async (w, u) => {
    const [t] = await chrome.tabs.query({ windowId: w, url: u });
    await chrome.tabs.update(t.id, { pinned: true });
  }, w1, `${P('b')}*`);
  await settle();
  s = await state();
  same = allSame(s);
  const bTabs = s.flatMap((w) => w.tabs).filter((t) => t.url === P('b'));
  check('pinning a synced tab takes it out of sync', same.ok && !synced(s[0]).includes('b'), same.seqs);
  check('…closing its stand-ins but keeping the pinned tab', bTabs.length === 1 && !bTabs[0].ghost && bTabs[0].pinned, JSON.stringify(bTabs));

  // A pinned tab of window 2's own (like a Dia Favorite) is never copied anywhere.
  await run((w, u) => chrome.tabs.create({ windowId: w, url: u, pinned: true, active: false }), w2, P('fav'));
  await settle();
  s = await state();
  same = allSame(s);
  const favTabs = s.flatMap((w) => w.tabs).filter((t) => t.url === P('fav'));
  check("a window's own pinned tabs are never copied", same.ok && favTabs.length === 1 && favTabs[0].pinned && !favTabs[0].ghost, `${same.seqs}; pinned: ${s.map((w) => pinnedOf(w).join(',')).join(' | ')}`);

  // Type into live page a, then open its stand-in in window 2: the live tab moves over with its state.
  const pageA = (await browser.pages()).find((p) => p.url() === P('a'));
  await pageA.type('#i', 'kept');
  const aTab = s.flatMap((w) => w.tabs).find((t) => !t.ghost && t.url === P('a'));
  await run(async (w) => chrome.windows.update(w, { focused: true }), w2);
  await sleep(300);
  const ghostA = (await state()).find((w) => w.id === w2).tabs.find((t) => t.ghost && t.url === P('a'));
  await run((id) => chrome.tabs.update(id, { active: true }), ghostA.id);
  await settle();
  s = await state();
  const movedA = s.flatMap((w) => w.tabs).find((t) => t.id === aTab.id);
  const focusedW2 = s.find((w) => w.id === w2).focused;
  check('opening a stand-in brings the live tab into this window', movedA && s.find((w) => w.id === w2).tabs.some((t) => t.id === aTab.id && t.active), `w2 focused=${focusedW2}`);
  check('…and still exactly one live copy', liveCount(s, 'a') === 1);
  const kept = await pageA.$eval('#i', (e) => e.value).catch(() => '(page gone)');
  check('…with its page state intact', kept === 'kept', kept);
  same = allSame(s);
  check('…and both windows still match', same.ok, same.seqs);

  // Close c from window 2 (its stand-in): closes everywhere.
  const ghostC = s.find((w) => w.id === w2).tabs.find((t) => t.url === P('c'));
  await run((id) => chrome.tabs.remove(id), ghostC.id);
  await settle();
  s = await state();
  check('closing a tab in one window closes it in all', s.every((w) => !synced(w).includes('c')) && liveCount(s, 'c') === 0, allSame(s).seqs);

  // New window gets every tab.
  const w3 = await run(async () => (await chrome.windows.create({ focused: false })).id);
  await settle(2000);
  s = await state();
  same = allSame(s);
  check('a new window is filled with every synced tab', same.ok && s.length === 3, same.seqs);

  // The live tab navigates: stand-ins follow.
  const liveD = s.flatMap((w) => w.tabs).find((t) => !t.ghost && t.url === P('d'));
  await run((id, u) => chrome.tabs.update(id, { url: u }), liveD.id, P('d2'));
  await settle();
  s = await state();
  same = allSame(s);
  const d2Ghost = s.flatMap((w) => w.tabs).find((t) => t.ghost && t.url === P('d2'));
  check('navigating the live tab updates its stand-ins', same.ok && synced(s[0]).includes('d2') && d2Ghost?.title === 'Page d2', same.seqs);

  // Drag the live tab a into window 3 (which already has its stand-in).
  const liveA = s.flatMap((w) => w.tabs).find((t) => !t.ghost && t.url === P('a'));
  await run((id, w) => chrome.tabs.move(id, { windowId: w, index: -1 }), liveA.id, w3);
  await settle();
  s = await state();
  same = allSame(s);
  check('dragging a tab to another window keeps one copy per window', same.ok && liveCount(s, 'a') === 1 && s.every((w) => synced(w).filter((x) => x === 'a').length === 1), same.seqs);
  check('…and the drop position becomes the shared order', synced(s[0]).at(-1) === 'a', same.seqs);

  // Pin the stand-in of a in window 1: the live tab moves there, pinned, and leaves sync.
  const liveA2 = s.flatMap((w) => w.tabs).find((t) => !t.ghost && t.url === P('a'));
  const ghostA1 = s.find((w) => w.id === w1).tabs.find((t) => t.ghost && t.url === P('a'));
  await run((id) => chrome.tabs.update(id, { pinned: true }), ghostA1.id);
  await settle();
  s = await state();
  same = allSame(s);
  const aTabs = s.flatMap((w) => w.tabs).filter((t) => t.url === P('a'));
  check('pinning a stand-in pins the real page there and takes it out of sync', aTabs.length === 1 && aTabs[0].id === liveA2.id && aTabs[0].pinned && s.find((w) => w.id === w1).tabs.some((t) => t.id === liveA2.id) && same.ok && !synced(s[0]).includes('a'), `${JSON.stringify(aTabs)} ${same.seqs}`);
  check('pinned tabs were never moved or copied', JSON.stringify(s.map(pinnedOf)) === JSON.stringify(s.map((w) => (w.id === w1 ? ['b', 'a'] : w.id === w2 ? ['fav'] : []))), s.map((w) => pinnedOf(w).join(',')).join(' | '));

  // Closing a window doesn't close its tabs elsewhere. Make sure it holds a live tab first.
  const liveD2 = s.flatMap((w) => w.tabs).find((t) => !t.ghost && t.url === P('d2'));
  await run((id, w) => chrome.tabs.move(id, { windowId: w, index: -1 }), liveD2.id, w2);
  await settle();
  s = await state();
  const before = synced(s.find((w) => w.id === w2));
  const liveInW2 = s.find((w) => w.id === w2).tabs.filter((t) => !t.ghost && !t.pinned && t.url.startsWith(base)).map((t) => t.url);
  await run((w) => chrome.windows.remove(w), w2);
  await settle();
  s = await state();
  check('closing a window keeps its tabs in the other windows', s.every((w) => synced(w).join() === before.join()), `${before.join()} → ${allSame(s).seqs}`);
  const orphans = s.flatMap((w) => w.tabs).filter((t) => liveInW2.includes(t.url));
  check('…as stand-ins when the live copy was in the closed window', liveInW2.length > 0 && orphans.length > 0 && orphans.every((t) => t.ghost), liveInW2.map((u) => u.slice(base.length)).join());

  // Opening that stand-in loads the page in place. (Window 3 is the focused one here:
  // headless Chrome doesn't deliver focus changes, so we stay in the window it last focused.)
  await run(async (w) => chrome.windows.update(w, { focused: true }), w3);
  await sleep(300);
  const orphan3 = s.find((w) => w.id === w3).tabs.find((t) => t.url === liveInW2[0]);
  await run((id) => chrome.tabs.update(id, { active: true }), orphan3.id);
  await settle();
  s = await state();
  const loaded = s.flatMap((w) => w.tabs).find((t) => t.id === orphan3.id);
  check('…and opening it loads the page', loaded && !loaded.ghost && loaded.url === liveInW2[0] && liveCount(s, liveInW2[0].slice(base.length + 1)) === 1, JSON.stringify(loaded));
  same = allSame(s);
  check('final: windows still match', same.ok, same.seqs);

  check('no service worker errors', swErrors.length === 0, swErrors.join(' | '));
} catch (e) {
  console.error(e);
  check('script ran to completion', false, String(e));
} finally {
  await browser.close();
  server.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

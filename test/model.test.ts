import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  deriveModel,
  emptyModel,
  ghostUrl,
  isEmptyPlan,
  mergeOrder,
  parseGhost,
  placeNew,
  planSwap,
  planWindow,
  v2Leftovers,
  type Entry,
  type Model,
  type SnapTab,
  type SnapWindow,
} from '../src/sync/model.ts';

const make = (sid: string, entry: Entry) => ghostUrl(sid, entry);
const page = (name: string) => `https://${name}.example/`;

/** Build windows from a compact spec: 'a' = live tab for page a, '~a' = stand-in for sid a, '*' prefix = pinned (Dia's Favorites/Pinned). */
function windows(spec: Record<number, string[]>, model?: Model): SnapWindow[] {
  let nextId = 1;
  return Object.entries(spec).map(([wid, tabs]) => ({
    id: Number(wid),
    tabs: tabs.map((t, index): SnapTab => {
      const pinned = t.startsWith('*');
      const name = t.replace(/^\*/, '').replace(/^~/, '');
      const isGhost = t.replace(/^\*/, '').startsWith('~');
      const id = Number(wid) * 100 + nextId++;
      const entry = model?.entries[name] ?? { url: page(name), title: name };
      return {
        id,
        windowId: Number(wid),
        index,
        url: isGhost ? ghostUrl(name, entry) : name === 'newtab' ? 'chrome://newtab/' : page(name),
        title: name,
        pinned,
        active: index === 0,
        discarded: isGhost,
        status: 'complete',
      };
    }),
  }));
}

/** Map unpinned live tabs to sid = page name (what a previous pass would have recorded). */
function bound(ws: SnapWindow[], model: Model): Model {
  const tabSid = { ...model.tabSid };
  for (const w of ws) {
    for (const t of w.tabs) {
      const ghost = parseGhost(t.url);
      if (!ghost && !t.pinned && t.url?.startsWith('https://')) tabSid[t.id] = new URL(t.url).hostname.split('.')[0]!;
    }
  }
  return { ...model, tabSid };
}

function modelOf(order: string[]): Model {
  const m = emptyModel();
  m.order = order;
  for (const s of order) m.entries[s] = { url: page(s), title: s };
  return m;
}

let counter = 0;
const opts = (extra: object = {}) => ({ newSid: () => `n${++counter}`, ...extra });

test('stand-in URLs round-trip and escape the page title', () => {
  const entry = { url: 'https://x.example/a?b=1&c=2', title: 'Hello <b> & "bye" -->' };
  const url = ghostUrl('s1', entry, 'data:image/png;base64,AAA=');
  assert.ok(url.startsWith('data:text/html;charset=utf-8,'));
  assert.deepEqual(parseGhost(url), { sid: 's1', url: entry.url, title: entry.title });
  const html = decodeURIComponent(url.slice(url.indexOf(',') + 1));
  assert.ok(html.includes('<title>Hello &lt;b&gt; &amp; &quot;bye&quot; --&gt;</title>'));
  assert.ok(html.includes('<link rel="icon" href="data:image/png;base64,AAA=">'));
  // Chrome may report the URL with different percent-encoding.
  assert.equal(parseGhost(url.replace(/%21/g, '!'))?.sid, 's1');
  assert.equal(parseGhost('data:text/html,<title>someone else</title>'), undefined);
  assert.equal(parseGhost('https://x.example/'), undefined);
  assert.equal(parseGhost(undefined), undefined);
});

test('mergeOrder keeps missing sids after the sid they used to follow', () => {
  assert.deepEqual(mergeOrder(['a', 'b', 'c', 'd'], ['c', 'a']), ['c', 'd', 'a', 'b']);
  assert.deepEqual(mergeOrder(['a', 'b', 'c'], []), ['a', 'b', 'c']);
  assert.deepEqual(mergeOrder(['a', 'b'], ['b', 'x']), ['a', 'b', 'x']);
});

test('placeNew inserts after the previous neighbour, before the next, or at the end', () => {
  const order = ['a', 'b'];
  placeNew(order, ['a', 'x', 'b']);
  assert.deepEqual(order, ['a', 'x', 'b']);
  placeNew(order, ['y', 'a']);
  assert.deepEqual(order, ['y', 'a', 'x', 'b']);
  placeNew(order, ['z']);
  assert.deepEqual(order, ['y', 'a', 'x', 'b', 'z']);
});

test('turning sync on unions every window, window by window', () => {
  const ws = windows({ 1: ['a', 'b'], 2: ['c', 'newtab'] });
  const { model } = deriveModel(ws, emptyModel(), opts());
  const titles = model.order.map((s) => model.entries[s]!.title);
  assert.deepEqual(titles, ['a', 'b', 'c']);
  assert.equal(Object.keys(model.tabSid).length, 3, 'new-tab page is not synced');
});

test('a new tab in one window gets a stand-in in the others, next to its neighbour', () => {
  const prev = modelOf(['a', 'b']);
  const ws = windows({ 1: ['a', 'x', 'b'], 2: ['~a', '~b'] });
  const m0 = bound(ws, prev);
  delete m0.tabSid[ws[0]!.tabs[1]!.id]; // x is new
  const { model } = deriveModel(ws, m0, opts());
  const xSid = model.tabSid[ws[0]!.tabs[1]!.id]!;
  assert.deepEqual(model.order, ['a', xSid, 'b']);

  const plan = planWindow(ws[1]!.tabs, model, make);
  assert.equal(plan.create.length, 1);
  assert.equal(plan.create[0]!.sid, xSid);
  assert.equal(plan.create[0]!.index, 1);
  assert.deepEqual(parseGhost(plan.create[0]!.url), { sid: xSid, url: page('x'), title: 'x' });
});

test('a new window is filled with stand-ins for every synced tab, after its own pinned tabs', () => {
  const prev = modelOf(['a', 'b', 'c']);
  const ws = windows({ 1: ['*fav', 'a', 'b', 'c'], 2: ['*fav', 'newtab'] });
  const { model } = deriveModel(ws, bound(ws, prev), opts());
  const plan = planWindow(ws[1]!.tabs, model, make);
  assert.deepEqual(
    plan.create.map((c) => [c.sid, c.index]),
    [
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ],
  );
});

test('reordering in the source window reorders the others', () => {
  const prev = modelOf(['a', 'b', 'c']);
  const ws = windows({ 1: ['c', 'a', 'b'], 2: ['~a', '~b', '~c'] });
  const { model } = deriveModel(ws, bound(ws, prev), opts({ source: 1 }));
  assert.deepEqual(model.order, ['c', 'a', 'b']);
  const plan = planWindow(ws[1]!.tabs, model, make);
  const ids = Object.fromEntries(ws[1]!.tabs.map((t) => [parseGhost(t.url)!.sid, t.id]));
  assert.deepEqual(plan.reorder, { tabIds: [ids.c, ids.a, ids.b], index: 0 });
});

test('reordering never moves pinned tabs', () => {
  const prev = modelOf(['a', 'b']);
  const ws = windows({ 1: ['*fav1', '*fav2', '~b', '~a'] });
  const { model } = deriveModel(ws, bound(ws, prev), opts());
  const plan = planWindow(ws[0]!.tabs, model, make);
  assert.deepEqual(plan.reorder, { tabIds: [ws[0]!.tabs[3]!.id, ws[0]!.tabs[2]!.id], index: 2 });
});

test('a window already in order needs nothing', () => {
  const prev = modelOf(['a', 'b']);
  const ws = windows({ 1: ['a', 'b'], 2: ['~a', '~b', 'newtab'] });
  const { model } = deriveModel(ws, bound(ws, prev), opts());
  for (const w of ws) {
    const tabs = w.tabs.map((t) => ({ ...t, discarded: true }));
    assert.ok(isEmptyPlan(planWindow(tabs, model, make)), `window ${w.id}`);
  }
});

test('without a source window, order does not change', () => {
  const prev = modelOf(['a', 'b']);
  const ws = windows({ 1: ['b', 'a'] });
  const { model } = deriveModel(ws, bound(ws, prev), opts());
  assert.deepEqual(model.order, ['a', 'b']);
});

test("pinned tabs (Dia's Favorites and Pinned) are never synced or touched", () => {
  // Each window has its own pinned tabs; only the regular tab is synced.
  const ws = windows({ 1: ['*mail', '*docs', 'a'], 2: ['*mail', 'newtab'] });
  const { model, close, promote } = deriveModel(ws, emptyModel(), opts());
  assert.deepEqual(Object.values(model.entries).map((e) => e.url), [page('a')]);
  assert.deepEqual(close, []);
  assert.deepEqual(promote, []);
  const plan = planWindow(ws[1]!.tabs, model, make);
  assert.equal(plan.create.length, 1, 'only the regular tab is mirrored');
  assert.equal(plan.reorder, undefined);
  assert.ok(isEmptyPlan(planWindow(ws[0]!.tabs, model, make)));
});

test('pinning a synced tab takes it out of sync: stand-ins close, the tab stays', () => {
  const prev = modelOf(['a', 'b']);
  const ws = windows({ 1: ['*b', 'a'], 2: ['~a', '~b'] });
  const m = bound(ws, prev);
  m.tabSid[ws[0]!.tabs[0]!.id] = 'b'; // b was synced before it got pinned
  const { model, close } = deriveModel(ws, m, opts({ source: 1 }));
  assert.deepEqual(model.order, ['a']);
  assert.equal(model.entries.b, undefined);
  assert.deepEqual(close, [ws[1]!.tabs[1]!.id], 'only the stand-in closes');
});

test('unpinning a tab makes it a synced tab', () => {
  const prev = modelOf(['a']);
  const ws = windows({ 1: ['a', 'b'], 2: ['~a'] });
  const { model } = deriveModel(ws, bound(ws, prev), opts());
  assert.equal(model.order.length, 2);
  assert.equal(planWindow(ws[1]!.tabs, model, make).create.length, 1);
});

test('pinning a stand-in moves the live tab there and takes it out of sync', () => {
  const prev = modelOf(['a', 'b']);
  const ws = windows({ 1: ['a', 'b'], 2: ['*~b', '~a'], 3: ['~a', '~b'] });
  const { model, close, promote } = deriveModel(ws, bound(ws, prev), opts());
  assert.equal(model.entries.b, undefined);
  assert.equal(promote.length, 1);
  assert.equal(promote[0]!.ghost.id, ws[1]!.tabs[0]!.id);
  assert.equal(promote[0]!.live?.id, ws[0]!.tabs[1]!.id);
  assert.deepEqual(close, [ws[2]!.tabs[1]!.id]);
});

test('cleanup after v0.2: copies of pinned tabs are closed, live tabs never', () => {
  const saved = {
    entries: {
      mail: { url: page('mail'), title: 'mail', pinned: true },
      docs: { url: page('docs'), title: 'docs', pinned: false },
      a: { url: page('a'), title: 'a', pinned: false },
    },
  };
  // mail was pinned in v0.2; docs is pinned in Dia but v0.2 mirrored it unpinned.
  const ws = windows({ 1: ['*mail', '*docs', 'a'], 2: ['*~mail', '~docs', '~a'] });
  const { close, drop } = v2Leftovers(ws, saved);
  assert.deepEqual(close.sort(), [ws[1]!.tabs[0]!.id, ws[1]!.tabs[1]!.id].sort());
  assert.deepEqual([...drop].sort(), ['docs', 'mail']);
});

test('closing a tab closes every copy, including the live one', () => {
  const prev = modelOf(['a', 'b']);
  const ws = windows({ 1: ['a', 'b'], 2: ['~a', '~b'] });
  const { model, close } = deriveModel(ws, bound(ws, prev), opts({ closed: new Set(['b']) }));
  assert.deepEqual(model.order, ['a']);
  assert.equal(model.entries.b, undefined);
  assert.deepEqual(close.sort(), [ws[0]!.tabs[1]!.id, ws[1]!.tabs[1]!.id].sort());
});

test('closing a window keeps its tabs as stand-ins elsewhere', () => {
  const prev = modelOf(['a', 'b']);
  const before = windows({ 1: ['a', 'b'], 2: ['~a', '~b'] });
  const m = bound(before, prev);
  const after = before.filter((w) => w.id === 2);
  const { model, close } = deriveModel(after, m, opts());
  assert.deepEqual(model.order, ['a', 'b']);
  assert.deepEqual(close, []);
  // Clicking the stand-in loads the page in place.
  const swap = planSwap(after, model, after[0]!.tabs[1]!);
  assert.deepEqual(swap, { kind: 'load', tabId: after[0]!.tabs[1]!.id, sid: 'b', url: page('b') });
});

test('after a restart, live tabs reclaim their sid by URL', () => {
  const saved = modelOf(['a', 'b']); // tabSid is empty after a restart
  const ws = windows({ 1: ['a', '~b'], 2: ['~a', 'b'] });
  const { model } = deriveModel(ws, saved, opts());
  assert.deepEqual(model.order, ['a', 'b']);
  assert.equal(model.tabSid[ws[0]!.tabs[0]!.id], 'a');
  assert.equal(model.tabSid[ws[1]!.tabs[1]!.id], 'b');
  for (const w of ws) assert.equal(planWindow(w.tabs, model, make).create.length, 0);
});

test('two live tabs with the same URL stay two synced tabs', () => {
  const ws = windows({ 1: ['a', 'a'] });
  const { model } = deriveModel(ws, emptyModel(), opts());
  assert.equal(model.order.length, 2);
});

test('dragging a live tab into a window that has its stand-in drops the stand-in', () => {
  const prev = modelOf(['a', 'b']);
  // b was live in window 1 and got dragged into window 2, next to its stand-in.
  const ws = windows({ 1: ['a'], 2: ['~a', 'b', '~b'] });
  const m = bound(ws, prev);
  const { model } = deriveModel(ws, m, opts({ source: 2 }));
  const p2 = planWindow(ws[1]!.tabs, model, make);
  assert.deepEqual(p2.close, [ws[1]!.tabs[2]!.id]);
  const p1 = planWindow(ws[0]!.tabs, model, make);
  assert.deepEqual(p1.create.map((c) => c.sid), ['b']);
});

test('stand-ins are replaced when the live tab navigates, not on title ticks', () => {
  const prev = modelOf(['a']);
  const ws = windows({ 1: ['a'], 2: ['newtab', '~a'] });
  ws[1]!.tabs[1]!.discarded = false;
  ws[0]!.tabs[0]!.title = 'a (2 unread)';
  let { model } = deriveModel(ws, bound(ws, prev), opts());
  let plan = planWindow(ws[1]!.tabs, model, make);
  assert.equal(plan.refresh.length, 0, 'title tick');
  assert.deepEqual(plan.discard, [ws[1]!.tabs[1]!.id], 'idle stand-in is unloaded');

  Object.assign(ws[0]!.tabs[0]!, { url: 'https://a.example/settings', title: 'Settings' });
  ({ model } = deriveModel(ws, model, opts()));
  plan = planWindow(ws[1]!.tabs, model, make);
  assert.equal(plan.refresh.length, 1);
  assert.deepEqual(parseGhost(plan.refresh[0]!.url), { sid: 'a', url: 'https://a.example/settings', title: 'Settings' });
  assert.equal(plan.refresh[0]!.index, 1);
});

test('a new tab joins once it has loaded', () => {
  const ws = windows({ 1: ['a'] });
  ws[0]!.tabs[0]!.status = 'loading';
  assert.equal(deriveModel(ws, emptyModel(), opts()).model.order.length, 0);
  ws[0]!.tabs[0]!.status = 'complete';
  assert.equal(deriveModel(ws, emptyModel(), opts()).model.order.length, 1);
});

test('a loading live tab does not churn its stand-ins', () => {
  const prev = modelOf(['a']);
  const ws = windows({ 1: ['a'] });
  Object.assign(ws[0]!.tabs[0]!, { status: 'loading', title: 'Loading…', url: 'https://a.example/next' });
  const { model } = deriveModel(ws, bound(ws, prev), opts());
  assert.equal(model.entries.a!.title, 'a');
});

test('clicking a stand-in swaps with the live tab in another window', () => {
  const prev = modelOf(['a', 'b']);
  const ws = windows({ 1: ['*fav', 'a', 'b'], 2: ['*fav', '~a', '~b'] });
  const m = bound(ws, prev);
  const plan = planSwap(ws, m, ws[1]!.tabs[1]!);
  assert.equal(plan?.kind, 'swap');
  if (plan?.kind === 'swap') assert.equal(plan.live.id, ws[0]!.tabs[1]!.id);
  assert.equal(planSwap(ws, m, ws[0]!.tabs[2]!), undefined, 'live tabs are not swapped');
});

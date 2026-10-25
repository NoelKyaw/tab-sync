// Chrome glue for the sync model. Event-driven: every tab/window event
// schedules a debounced reconcile pass, and all passes run one at a time.
import { tabUrl } from '../lib/match.ts';
import { faviconUrl } from '../lib/tabs.ts';
import {
  deriveModel,
  emptyModel,
  ghostUrl,
  isEmptyPlan,
  parseGhost,
  planSwap,
  planWindow,
  type Derived,
  type Entry,
  type Model,
  type Sid,
  type SnapTab,
  type SnapWindow,
  type WindowPlan,
  v2Leftovers,
} from './model.ts';

const ENABLED_KEY = 'enabled';
const SAVED_KEY = 'saved';
const SESSION_KEY = 'model';
/** Bumped when stored state changes meaning. 3: pinned tabs are no longer synced. */
const SCHEMA = 3;

// ---- State ------------------------------------------------------------------
// The model lives in storage.session (survives service-worker restarts) and
// its order/entries in storage.local (survives browser restarts).

type Stored<T> = T & { v?: number };

let model: Model | undefined;
let enabled: boolean | undefined;
/** State was written by an older version; clean up its leftovers on the next pass. */
let upgrading = false;

async function isEnabled(): Promise<boolean> {
  enabled ??= ((await chrome.storage.local.get(ENABLED_KEY))[ENABLED_KEY] as boolean | undefined) ?? true;
  return enabled;
}

async function getModel(): Promise<Model> {
  if (model) return model;
  const session = (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY] as Stored<Model> | undefined;
  if (session) {
    upgrading = session.v !== SCHEMA;
    return (model = { order: session.order, entries: session.entries, tabSid: session.tabSid });
  }
  const saved = (await chrome.storage.local.get(SAVED_KEY))[SAVED_KEY] as Stored<Pick<Model, 'order' | 'entries'>> | undefined;
  upgrading = !!saved && saved.v !== SCHEMA;
  return (model = saved ? { order: saved.order, entries: saved.entries, tabSid: {} } : emptyModel());
}

async function save(): Promise<void> {
  if (!model) return;
  await chrome.storage.session.set({ [SESSION_KEY]: { v: SCHEMA, ...model } });
  await chrome.storage.local.set({ [SAVED_KEY]: { v: SCHEMA, order: model.order, entries: model.entries } });
}

// ---- Telling our own changes from the user's ------------------------------

/** Tabs we just moved/pinned/activated: their events don't make a window the source. */
const ours = new Map<number, number>();
/** Tabs we closed, or stand-ins we just created: their removal isn't a user close. */
const expectedRemoval = new Map<number, number>();

function mark(map: Map<number, number>, ids: readonly number[], ms: number): void {
  const until = Date.now() + ms;
  for (const id of ids) map.set(id, until);
}

function isMarked(map: Map<number, number>, id: number): boolean {
  const until = map.get(id);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  map.delete(id);
  return false;
}

// ---- Scheduling -----------------------------------------------------------

let chain: Promise<void> = Promise.resolve();
function enqueue(task: () => Promise<void>): Promise<void> {
  chain = chain.then(task).catch((e) => console.error('[tab-sync]', e));
  return chain;
}

let source: number | undefined;
const closed = new Set<Sid>();
/** User closes still being checked (see onRemoved). Reconciles wait for them. */
let pendingRemovals = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let dueAt = 0;

function schedule(delay = 250): void {
  const due = Date.now() + delay;
  if (timer !== undefined && dueAt <= due) return;
  clearTimeout(timer);
  dueAt = due;
  timer = setTimeout(() => {
    timer = undefined;
    void enqueue(reconcile);
  }, delay);
}

function userChanged(windowId: number): void {
  source = windowId;
  schedule();
}

// Safety valve: if a window keeps needing reorders (e.g. the browser keeps
// rejecting a move), stop reordering it for a while instead of looping.
const reorderLog = new Map<number, number[]>();
function reorderAllowed(windowId: number): boolean {
  const now = Date.now();
  const recent = (reorderLog.get(windowId) ?? []).filter((t) => now - t < 10_000);
  reorderLog.set(windowId, recent);
  if (recent.length >= 5) return false;
  recent.push(now);
  return true;
}

// ---- Reconcile ------------------------------------------------------------

function toSnap(t: chrome.tabs.Tab): SnapTab {
  return {
    id: t.id!,
    windowId: t.windowId,
    index: t.index,
    url: t.url,
    pendingUrl: t.pendingUrl,
    title: t.title,
    pinned: t.pinned,
    active: t.active,
    discarded: t.discarded,
    status: t.status,
  };
}

async function snapshot(): Promise<SnapWindow[]> {
  const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  return wins
    .filter((w) => !w.incognito && w.id !== undefined)
    .map((w) => ({
      id: w.id!,
      tabs: (w.tabs ?? []).filter((t) => t.id !== undefined).map(toSnap).sort((a, b) => a.index - b.index),
    }));
}

async function reconcile(): Promise<void> {
  if (!(await isEnabled())) return;
  if (pendingRemovals > 0) return schedule(100);
  let prev = await getModel();
  let windows = await snapshot();
  if (upgrading) {
    const { close, drop } = v2Leftovers(windows, prev);
    await removeTabs(close);
    prev = { ...prev, order: prev.order.filter((s) => !drop.has(s)) };
    for (const sid of drop) delete prev.entries[sid];
    upgrading = false;
    windows = await snapshot();
  }
  const src = source;
  const closedNow = new Set(closed);
  source = undefined;
  closed.clear();

  const derived = deriveModel(windows, prev, {
    source: src,
    closed: closedNow,
    newSid: () => crypto.randomUUID(),
  });
  model = derived.model;
  await removeTabs(derived.close);
  for (const p of derived.promote) await promote(p);
  await loadIcons(Object.values(model.entries));
  for (const w of windows) await syncWindow(w.id);
  await save();
}

async function syncWindow(windowId: number): Promise<void> {
  for (let pass = 0; pass < 3; pass++) {
    const tabs = await chrome.tabs.query({ windowId }).catch(() => [] as chrome.tabs.Tab[]);
    if (tabs.length === 0) return;
    const plan = planWindow(tabs.filter((t) => t.id !== undefined).map(toSnap), model!, makeGhost);
    if (plan.reorder && !reorderAllowed(windowId)) delete plan.reorder;
    if (isEmptyPlan(plan)) return;
    await applyPlan(windowId, plan);
  }
}

async function applyPlan(windowId: number, plan: WindowPlan): Promise<void> {
  await removeTabs(plan.close);
  for (const c of plan.create) {
    const tab = await chrome.tabs.create({ windowId, index: c.index, url: c.url, active: false });
    if (tab.id !== undefined) {
      model!.tabSid[tab.id] = c.sid;
      mark(expectedRemoval, [tab.id], 3000);
    }
  }
  for (const r of plan.refresh) {
    // Chrome won't navigate a tab to a data: URL, so swap in a fresh stand-in.
    const tab = await chrome.tabs
      .create({ windowId, index: r.index, url: r.url, active: r.active })
      .catch(() => undefined);
    if (tab?.id === undefined) continue;
    model!.tabSid[tab.id] = model!.tabSid[r.tabId]!;
    mark(expectedRemoval, [tab.id], 3000);
    await removeTabs([r.tabId]);
  }
  for (const id of plan.discard) await chrome.tabs.discard(id).catch(() => {});
  if (plan.reorder) {
    mark(ours, plan.reorder.tabIds, 1000);
    await chrome.tabs.move(plan.reorder.tabIds, { index: plan.reorder.index }).catch(() => {});
  }
}

/** The user pinned a stand-in: the page leaves sync and becomes a real pinned tab there. */
async function promote({ ghost, url, live }: Derived['promote'][number]): Promise<void> {
  if (!live) {
    await chrome.tabs.update(ghost.id, { url }).catch(() => {});
    return;
  }
  mark(ours, [live.id], 1000);
  await chrome.tabs.move(live.id, { windowId: ghost.windowId, index: ghost.index }).catch(() => {});
  await chrome.tabs.update(live.id, { pinned: true, ...(ghost.active ? { active: true } : {}) }).catch(() => {});
  await removeTabs([ghost.id]);
}

async function removeTabs(ids: readonly number[]): Promise<void> {
  if (ids.length === 0) return;
  mark(expectedRemoval, ids, 5000);
  await chrome.tabs.remove([...ids]).catch(() => {});
}

// ---- Favicons for stand-ins ---------------------------------------------
// Read from the browser's own favicon cache (no network) and embedded in the
// stand-in, since a data: page can't load extension URLs. Cached per site for
// the life of the service worker.

const icons = new Map<string, string>();

function siteOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

async function loadIcons(entries: readonly Entry[]): Promise<void> {
  for (const e of entries) {
    const site = siteOf(e.url);
    if (icons.has(site)) continue;
    try {
      const res = await fetch(faviconUrl(e.url, 32));
      const bytes = new Uint8Array(await res.arrayBuffer());
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      icons.set(site, `data:${res.headers.get('content-type') || 'image/png'};base64,${btoa(bin)}`);
    } catch {
      icons.set(site, '');
    }
  }
}

const makeGhost = (sid: Sid, entry: Entry): string => ghostUrl(sid, entry, icons.get(siteOf(entry.url)));

// ---- Clicking a stand-in --------------------------------------------------

/** Last swap per sid. A tab that just moved doesn't move again right away. */
const lastSwap = new Map<Sid, number>();

/** Tracked from focus events; WINDOW_ID_NONE when another app is in front. */
let focusedWindow: number | undefined;

async function currentWindow(): Promise<number | undefined> {
  if (focusedWindow !== undefined) return focusedWindow;
  const win = await chrome.windows.getLastFocused().catch(() => undefined);
  return win?.focused && win.type === 'normal' ? win.id : undefined;
}

/** If the focused window is showing a stand-in, bring the real tab here. */
async function maybeSwap(windowId: number): Promise<void> {
  if (!(await isEnabled())) return;
  // Exactly one window counts as focused, so two windows can never pull the
  // same tab back and forth.
  if ((await currentWindow()) !== windowId) return;
  const [active] = await chrome.tabs.query({ windowId, active: true });
  if (active?.id === undefined || !parseGhost(tabUrl(active))) return;

  const m = await getModel();
  const plan = planSwap(await snapshot(), m, toSnap(active));
  if (!plan) return;
  if (plan.kind === 'swap') {
    if (Date.now() - (lastSwap.get(plan.sid) ?? 0) < 1000) return;
    lastSwap.set(plan.sid, Date.now());
  }
  if (plan.kind === 'load') {
    m.tabSid[plan.tabId] = plan.sid;
    await chrome.tabs.update(plan.tabId, { url: plan.url });
  } else if (plan.kind === 'focus') {
    mark(ours, [plan.live], 1000);
    await chrome.tabs.update(plan.live, { active: true });
    await removeTabs([plan.ghost]);
  } else {
    const { live, ghost } = plan;
    mark(ours, [live.id, ghost.id], 1500);
    await chrome.tabs.move(live.id, { windowId: ghost.windowId, index: ghost.index });
    await chrome.tabs.update(live.id, { active: true });
    await chrome.tabs.move(ghost.id, { windowId: live.windowId, index: live.index });
    // Keep the other window on the same tab; it swaps back when you return to it.
    if (live.active) await chrome.tabs.update(ghost.id, { active: true });
  }
  await save();
  schedule();
}

// ---- On / off -------------------------------------------------------------

async function updateBadge(): Promise<void> {
  const on = await isEnabled();
  await chrome.action.setBadgeText({ text: on ? '' : 'off' });
  await chrome.action.setTitle({ title: on ? 'Tab Sync is on. Click to pause.' : 'Tab Sync is paused. Click to resume.' });
}

/** Pause: close stand-ins whose tab is open somewhere, keep one of the rest. */
async function teardown(): Promise<void> {
  const m = await getModel();
  const windows = await snapshot();
  const liveSids = new Set<Sid>();
  for (const w of windows) {
    for (const t of w.tabs) if (!parseGhost(tabUrl(t)) && m.tabSid[t.id]) liveSids.add(m.tabSid[t.id]!);
  }
  const kept = new Set<Sid>();
  const close: number[] = [];
  for (const w of windows) {
    for (const t of w.tabs) {
      const ghost = parseGhost(tabUrl(t));
      if (!ghost) continue;
      if (liveSids.has(ghost.sid) || kept.has(ghost.sid)) close.push(t.id);
      else kept.add(ghost.sid);
    }
  }
  await removeTabs(close);
  model = emptyModel();
  await chrome.storage.session.remove(SESSION_KEY);
  await chrome.storage.local.remove(SAVED_KEY);
}

async function toggle(): Promise<void> {
  enabled = !(await isEnabled());
  await chrome.storage.local.set({ [ENABLED_KEY]: enabled });
  await updateBadge();
  if (enabled) {
    model = emptyModel();
    await reconcile();
  } else {
    await teardown();
  }
}

// ---- Wiring ---------------------------------------------------------------

export function startSync(): void {
  chrome.runtime.onInstalled.addListener(() => {
    void updateBadge();
    schedule(500);
  });
  chrome.runtime.onStartup.addListener(() => {
    void updateBadge();
    // Let the browser finish restoring windows first.
    schedule(1500);
  });
  chrome.action.onClicked.addListener(() => void enqueue(toggle));

  chrome.tabs.onCreated.addListener((tab) => {
    if (!parseGhost(tabUrl(tab))) schedule();
  });
  chrome.tabs.onUpdated.addListener((_tabId, change) => {
    // Title-only changes (unread counts, timers) are ignored on purpose: they
    // don't refresh stand-ins, and would keep the service worker awake.
    if (change.pinned !== undefined || change.url !== undefined || change.status === 'complete') schedule();
  });
  chrome.tabs.onMoved.addListener((tabId, info) => {
    if (isMarked(ours, tabId)) schedule();
    else userChanged(info.windowId);
  });
  chrome.tabs.onAttached.addListener((tabId, info) => {
    if (isMarked(ours, tabId)) schedule();
    else userChanged(info.newWindowId);
  });
  chrome.tabs.onDetached.addListener(() => schedule());
  chrome.tabs.onReplaced.addListener((added, removed) => {
    void enqueue(async () => {
      const m = await getModel();
      const sid = m.tabSid[removed];
      if (sid) m.tabSid[added] = sid;
      delete m.tabSid[removed];
    });
  });
  chrome.tabs.onRemoved.addListener((tabId, info) => {
    if (isMarked(expectedRemoval, tabId) || info.isWindowClosing) return;
    // Read the sid now, before a later pass forgets the tab.
    const known = model?.tabSid[tabId];
    pendingRemovals++;
    // Closing a window must never close its tabs elsewhere. Some browsers don't
    // set isWindowClosing reliably, so check the window still exists.
    setTimeout(() => {
      void enqueue(async () => {
        try {
          if (!(await isEnabled())) return;
          const windowOpen = await chrome.windows.get(info.windowId).then(() => true, () => false);
          const sid = known ?? (await getModel()).tabSid[tabId];
          if (windowOpen && sid) closed.add(sid);
        } finally {
          pendingRemovals--;
          schedule();
        }
      });
    }, 300);
  });

  chrome.tabs.onActivated.addListener(({ windowId }) => void enqueue(() => maybeSwap(windowId)));
  chrome.windows.onFocusChanged.addListener((windowId) => {
    focusedWindow = windowId;
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    // Give a click on another tab a moment to land, so just focusing a window
    // doesn't pull a tab over first.
    setTimeout(() => void enqueue(() => maybeSwap(windowId)), 150);
  });
  chrome.windows.onCreated.addListener(() => schedule());
  chrome.windows.onRemoved.addListener((windowId) => {
    if (focusedWindow === windowId) focusedWindow = undefined;
  });
}

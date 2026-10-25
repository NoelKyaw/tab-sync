// Pure sync logic (no chrome.* calls) so it can be unit-tested in Node.
//
// Every synced tab has a sync id (sid). Each window shows every sid, in the
// same order. Exactly one window holds the live tab for a sid; the others hold
// a stand-in: a self-contained data: page that only carries the title and
// favicon, and is discarded once loaded.
//
// Stand-ins are data: pages, not extension pages, because discarding an
// extension page takes down the extension's own process (and with it the
// service worker). Chrome also refuses tabs.update() to a data: URL, so a
// stale stand-in is replaced rather than navigated.
import { normalizeUrl, tabUrl } from '../lib/match.ts';

export type Sid = string;

export interface Entry {
  url: string;
  title: string;
  pinned: boolean;
}

export interface Model {
  /** Canonical tab order, shared by every window. */
  order: Sid[];
  entries: Record<Sid, Entry>;
  /** tabId -> sid for every tab we track, live or stand-in. */
  tabSid: Record<number, Sid>;
}

export interface SnapTab {
  id: number;
  windowId: number;
  index: number;
  url?: string;
  pendingUrl?: string;
  title?: string;
  pinned: boolean;
  active: boolean;
  discarded: boolean;
  status?: string;
}

export interface SnapWindow {
  id: number;
  /** Sorted by index. */
  tabs: SnapTab[];
}

export const emptyModel = (): Model => ({ order: [], entries: {}, tabSid: {} });

// ---- Stand-in URLs ---------------------------------------------------------

export interface GhostInfo {
  sid: Sid;
  url: string;
  title: string;
}

const GHOST_PREFIX = 'data:text/html;charset=utf-8,';
const GHOST_MARK = '<!--tabsync?';

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A stand-in page for `entry`. `icon` is a data: URI of the favicon, if known. */
export function ghostUrl(sid: Sid, entry: Entry, icon = ''): string {
  const meta = new URLSearchParams({ sid, u: entry.url, t: entry.title });
  const title = escapeHtml(entry.title || entry.url);
  const html =
    `${GHOST_MARK}${meta}-->` +
    `<meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>${title}</title>` +
    (icon ? `<link rel="icon" href="${escapeHtml(icon)}">` : '') +
    '<style>html,body{height:100%;margin:0}body{display:grid;place-items:center;font:14px/1.4 system-ui,sans-serif;color:GrayText;text-align:center}' +
    'main{max-width:32em;padding:24px}img{width:32px;height:32px}h1{margin:8px 0;font-size:15px;font-weight:500;color:CanvasText;overflow-wrap:anywhere}a{color:inherit}</style>' +
    `<main>${icon ? `<img alt="" src="${escapeHtml(icon)}">` : ''}<h1>${title}</h1>` +
    `<p>This tab is synced by Tab Sync. It loads when you switch to it, or <a href="${escapeHtml(entry.url)}">open it now</a>.</p></main>`;
  return GHOST_PREFIX + encodeURIComponent(html);
}

export function parseGhost(url: string | undefined): GhostInfo | undefined {
  if (!url?.startsWith('data:text/html')) return undefined;
  let html: string;
  try {
    html = decodeURIComponent(url.slice(url.indexOf(',') + 1));
  } catch {
    return undefined;
  }
  if (!html.startsWith(GHOST_MARK)) return undefined;
  const p = new URLSearchParams(html.slice(GHOST_MARK.length, html.indexOf('-->')));
  const sid = p.get('sid');
  if (!sid) return undefined;
  return { sid, url: p.get('u') ?? '', title: p.get('t') ?? '' };
}

/** Only real web pages are synced; new-tab pages and browser pages stay per-window. */
export function isSyncable(url: string): boolean {
  return /^(https?|file):/i.test(url);
}

// ---- Deriving the shared model from what the windows show ------------------

export interface DeriveOptions {
  /** Window the user just changed (moved/pinned/dragged tabs). Its order wins. */
  source?: number;
  /** Sids the user closed since the last pass. Closed everywhere. */
  closed?: ReadonlySet<Sid>;
  newSid: () => Sid;
}

export interface Derived {
  model: Model;
  /** Tabs of closed sids, in any window. */
  close: number[];
}

export function deriveModel(windows: readonly SnapWindow[], prev: Model, opts: DeriveOptions): Derived {
  const closed = opts.closed ?? new Set<Sid>();
  const entries: Record<Sid, Entry> = {};
  for (const [sid, e] of Object.entries(prev.entries)) if (!closed.has(sid)) entries[sid] = { ...e };
  const tabSid: Record<number, Sid> = {};
  const close: number[] = [];
  const live = new Map<Sid, SnapTab>();
  const unmapped: SnapTab[] = [];
  const fresh = new Set<Sid>();

  // Stand-ins carry their sid; live tabs are looked up in the previous model.
  for (const w of windows) {
    for (const tab of w.tabs) {
      const ghost = parseGhost(tabUrl(tab));
      const sid = ghost?.sid ?? prev.tabSid[tab.id];
      if (sid && closed.has(sid)) {
        close.push(tab.id);
      } else if (ghost) {
        tabSid[tab.id] = ghost.sid;
        // A stand-in we don't know about (sync was off, or state was lost): adopt it.
        entries[ghost.sid] ??= { url: ghost.url, title: ghost.title, pinned: tab.pinned };
      } else if (sid && entries[sid] && !live.has(sid)) {
        live.set(sid, tab);
        tabSid[tab.id] = sid;
      } else if (isSyncable(tabUrl(tab)) && tab.status !== 'loading') {
        // New tabs join once loaded, so their stand-ins get the real title.
        unmapped.push(tab);
      }
    }
  }

  // New live tabs. Reuse a sid that only has stand-ins left (its window was
  // closed, or the browser restarted) when the URL matches; otherwise mint one.
  const orphans = new Map<string, Sid[]>();
  for (const sid of [...prev.order, ...Object.keys(entries)]) {
    if (live.has(sid) || !entries[sid]) continue;
    const key = normalizeUrl(entries[sid].url);
    const list = orphans.get(key) ?? [];
    if (!list.includes(sid)) list.push(sid);
    orphans.set(key, list);
  }
  for (const tab of unmapped) {
    let sid = orphans.get(normalizeUrl(tabUrl(tab)))?.shift();
    if (!sid) {
      sid = opts.newSid();
      fresh.add(sid);
      entries[sid] = { url: tabUrl(tab), title: tab.title || tabUrl(tab), pinned: tab.pinned };
    }
    live.set(sid, tab);
    tabSid[tab.id] = sid;
  }

  // The live tab is the truth for URL and title. Wait for loads to finish so
  // stand-ins aren't refreshed for every intermediate title.
  for (const [sid, tab] of live) {
    const url = tabUrl(tab);
    if (tab.status === 'loading' && !fresh.has(sid)) continue;
    if (!isSyncable(url)) continue;
    entries[sid] = { ...entries[sid]!, url, title: tab.title || entries[sid]!.title || url };
  }

  // Order: the source window's order (and pin state) wins; everything else keeps its place.
  const src = windows.find((w) => w.id === opts.source);
  const srcTabs = src ? windowTabs(src, tabSid, live) : new Map<Sid, SnapTab>();
  for (const [sid, tab] of srcTabs) if (entries[sid]) entries[sid].pinned = tab.pinned;
  const order = mergeOrder(
    prev.order.filter((s) => entries[s]),
    seqOf(srcTabs).filter((s) => entries[s]),
  );
  for (const w of windows) placeNew(order, seqOf(windowTabs(w, tabSid, live)));
  for (const sid of Object.keys(entries)) if (!order.includes(sid)) order.push(sid);

  return { model: { order, entries, tabSid }, close };
}

/** One tab per sid in a window. A duplicated sid is represented by its live tab. */
function windowTabs(w: SnapWindow, tabSid: Record<number, Sid>, live: Map<Sid, SnapTab>): Map<Sid, SnapTab> {
  const out = new Map<Sid, SnapTab>();
  for (const tab of w.tabs) {
    const sid = tabSid[tab.id];
    if (sid && (!out.has(sid) || live.get(sid) === tab)) out.set(sid, tab);
  }
  return out;
}

function seqOf(tabs: Map<Sid, SnapTab>): Sid[] {
  return [...tabs.keys()].sort((a, b) => tabs.get(a)!.index - tabs.get(b)!.index);
}

/**
 * Take `next` as the new order, and slot every sid that's only in `prev`
 * back in after the sid it used to follow.
 */
export function mergeOrder(prev: readonly Sid[], next: readonly Sid[]): Sid[] {
  const out = [...new Set(next)];
  let anchor = -1;
  for (const sid of prev) {
    const at = out.indexOf(sid);
    if (at !== -1) {
      anchor = at;
    } else {
      out.splice(anchor + 1, 0, sid);
      anchor += 1;
    }
  }
  return out;
}

/** Add sids that aren't in `order` yet next to their neighbours in `seq`. Mutates `order`. */
export function placeNew(order: Sid[], seq: readonly Sid[]): void {
  seq.forEach((sid, i) => {
    if (order.includes(sid)) return;
    const before = seq.slice(0, i).reverse().find((s) => order.includes(s));
    if (before !== undefined) {
      order.splice(order.indexOf(before) + 1, 0, sid);
      return;
    }
    const after = seq.slice(i + 1).find((s) => order.includes(s));
    if (after !== undefined) order.splice(order.indexOf(after), 0, sid);
    else order.push(sid);
  });
}

// ---- Making one window match the model -------------------------------------

export interface WindowPlan {
  /** Extra stand-ins (a sid shown twice in this window). */
  close: number[];
  /** Missing sids. Apply in order; each index assumes the previous ones were created. */
  create: { sid: Sid; index: number; pinned: boolean; url: string }[];
  pin: { tabId: number; pinned: boolean }[];
  /** Stand-ins for a page that has since navigated. Replaced in place. */
  refresh: { tabId: number; index: number; pinned: boolean; active: boolean; url: string }[];
  /** Loaded, hidden stand-ins to unload. */
  discard: number[];
  /** Synced tabs to put back in canonical order (only when nothing else changes). */
  reorder?: { pinned: number[]; unpinned: number[]; unpinnedIndex: number };
}

export function isEmptyPlan(p: WindowPlan): boolean {
  return !p.close.length && !p.create.length && !p.pin.length && !p.refresh.length && !p.discard.length && !p.reorder;
}

/** Builds the stand-in URL for a sid (the engine supplies the favicon). */
export type MakeGhost = (sid: Sid, entry: Entry) => string;

export function planWindow(tabs: readonly SnapTab[], model: Model, makeGhost: MakeGhost): WindowPlan {
  const plan: WindowPlan = { close: [], create: [], pin: [], refresh: [], discard: [] };
  const sorted = [...tabs].sort((a, b) => a.index - b.index);
  const inOrder = new Set(model.order);

  const ghosts = new Map<number, GhostInfo>();
  for (const tab of sorted) {
    const ghost = parseGhost(tabUrl(tab));
    if (ghost) ghosts.set(tab.id, ghost);
  }
  const sidOf = (tab: SnapTab): Sid | undefined => ghosts.get(tab.id)?.sid ?? model.tabSid[tab.id];

  const chosen = new Map<Sid, SnapTab>();
  for (const tab of sorted) {
    const ghost = ghosts.get(tab.id);
    const sid = sidOf(tab);
    if (!sid || !inOrder.has(sid)) continue;
    const prev = chosen.get(sid);
    if (!prev) chosen.set(sid, tab);
    else if (ghosts.has(prev.id) && !ghost) {
      plan.close.push(prev.id);
      chosen.set(sid, tab);
    } else if (ghost) plan.close.push(tab.id);
  }

  // Missing sids become stand-ins next to their predecessor.
  const slots: { sid?: Sid; pinned: boolean }[] = sorted
    .filter((t) => !plan.close.includes(t.id))
    .map((t) => ({ sid: sidOf(t), pinned: t.pinned }));
  model.order.forEach((sid, i) => {
    if (chosen.has(sid)) return;
    const entry = model.entries[sid]!;
    const prevSids = new Set(model.order.slice(0, i));
    let index = -1;
    for (let k = slots.length - 1; k >= 0; k--) {
      if (slots[k]!.sid && prevSids.has(slots[k]!.sid!)) {
        index = k + 1;
        break;
      }
    }
    const pinnedCount = slots.filter((s) => s.pinned).length;
    if (index === -1) index = entry.pinned ? 0 : pinnedCount;
    index = entry.pinned ? Math.min(index, pinnedCount) : Math.max(index, pinnedCount);
    slots.splice(index, 0, { sid, pinned: entry.pinned });
    plan.create.push({ sid, index, pinned: entry.pinned, url: makeGhost(sid, entry) });
  });

  for (const [sid, tab] of chosen) {
    const entry = model.entries[sid]!;
    if (tab.pinned !== entry.pinned) plan.pin.push({ tabId: tab.id, pinned: entry.pinned });
    const ghost = ghosts.get(tab.id);
    if (!ghost) continue;
    if (isStale(ghost, entry)) {
      plan.refresh.push({ tabId: tab.id, index: tab.index, pinned: tab.pinned, active: tab.active, url: makeGhost(sid, entry) });
    } else if (!tab.active && !tab.discarded && tab.status === 'complete') {
      plan.discard.push(tab.id);
    }
  }

  if (plan.close.length || plan.create.length || plan.pin.length) return plan;

  // Same tabs, possibly in a different order.
  const current = sorted.filter((t) => { const sid = sidOf(t); return sid !== undefined && chosen.get(sid) === t; });
  const want = model.order.filter((s) => chosen.has(s)).map((s) => chosen.get(s)!);
  const pinned = want.filter((t) => t.pinned);
  const unpinned = want.filter((t) => !t.pinned);
  const same = (a: SnapTab[], b: SnapTab[]) => a.length === b.length && a.every((t, i) => t === b[i]);
  if (!same(current.filter((t) => t.pinned), pinned) || !same(current.filter((t) => !t.pinned), unpinned)) {
    plan.reorder = {
      pinned: pinned.map((t) => t.id),
      unpinned: unpinned.map((t) => t.id),
      unpinnedIndex: sorted.filter((t) => t.pinned).length,
    };
  }
  return plan;
}

/**
 * Replacing a stand-in is visible in the tab bar, so only do it when the live
 * tab went to another page, or the stand-in never got a real title. Title
 * ticks (unread counts, timers) are left alone.
 */
function isStale(ghost: GhostInfo, entry: Entry): boolean {
  if (normalizeUrl(ghost.url) !== normalizeUrl(entry.url)) return true;
  const placeholder = !ghost.title || ghost.title === ghost.url;
  return placeholder && !!entry.title && entry.title !== ghost.title;
}

// ---- Clicking a stand-in ---------------------------------------------------

export type SwapPlan =
  /** No live tab anywhere: the stand-in loads the page itself. */
  | { kind: 'load'; tabId: number; sid: Sid; url: string }
  /** The live tab is already in this window: show it, drop the stand-in. */
  | { kind: 'focus'; live: number; ghost: number }
  /** Trade places: live tab comes here, stand-in goes where the live tab was. */
  | { kind: 'swap'; sid: Sid; live: SnapTab; ghost: SnapTab; pinned: boolean };

export function planSwap(windows: readonly SnapWindow[], model: Model, ghost: SnapTab): SwapPlan | undefined {
  const info = parseGhost(tabUrl(ghost));
  if (!info) return undefined;
  const entry = model.entries[info.sid];
  let live: SnapTab | undefined;
  for (const w of windows) {
    for (const t of w.tabs) {
      if (model.tabSid[t.id] === info.sid && !parseGhost(tabUrl(t))) live = t;
    }
  }
  if (!live) return { kind: 'load', tabId: ghost.id, sid: info.sid, url: entry?.url || info.url };
  if (live.windowId === ghost.windowId) return { kind: 'focus', live: live.id, ghost: ghost.id };
  return { kind: 'swap', sid: info.sid, live, ghost, pinned: entry?.pinned ?? ghost.pinned };
}

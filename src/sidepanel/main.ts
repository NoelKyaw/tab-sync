// Side panel UI. One instance per open panel (one per window). It keeps no
// copy of the tab list beyond the last query result: on any relevant browser
// event it re-queries (debounced) and re-renders. Closing the panel frees it.
import { h } from '../lib/dom.ts';
import {
  findPinTab,
  matches,
  pinState,
  queryTerms,
  tabUrl,
  type Bindings,
  type Pin,
} from '../lib/match.ts';
import { addPin, isPinStorageChange, loadBindings, loadPins, removePin } from '../lib/pins.ts';
import { bringHere, faviconUrl, goTo, openPin } from '../lib/tabs.ts';
import { highlight, hostname, timeAgo } from '../lib/text.ts';

type Tab = chrome.tabs.Tab;
type Session = chrome.sessions.Session;
type Part = 'tabs' | 'pins' | 'closed';
type MenuItem = { label: string; kbd?: string; disabled?: boolean; run: () => void } | '-';

/** A keyboard-navigable row: Enter runs `go`, Shift+Enter runs `here`. */
interface NavItem {
  el: HTMLElement;
  go: () => void;
  here?: () => void;
}

const $list = document.getElementById('list')!;
const $foot = document.getElementById('foot')!;
const $menu = document.getElementById('menu')!;
const $q = document.getElementById('q') as HTMLInputElement;
const $qHint = document.getElementById('q-hint')!;

if (new URLSearchParams(location.search).get('mode') === 'popup') {
  document.body.classList.add('popup');
}

const state = {
  windowId: -1,
  tabs: [] as Tab[],
  pins: [] as Pin[],
  bindings: {} as Bindings,
  closed: [] as Session[],
  query: '',
  /** Collapsed section keys: `w:<windowId>` or `closed`. */
  collapsed: new Set<string>(['closed']),
  editingPins: false,
  selected: -1,
};
let nav: NavItem[] = [];

// ---------------------------------------------------------------- data

const loaders: Record<Part, () => Promise<void>> = {
  tabs: async () => {
    const tabs = await chrome.tabs.query({ windowType: 'normal' });
    state.tabs = tabs.sort((a, b) => a.windowId - b.windowId || a.index - b.index);
  },
  pins: async () => {
    [state.pins, state.bindings] = await Promise.all([loadPins(), loadBindings()]);
  },
  closed: async () => {
    state.closed = await chrome.sessions.getRecentlyClosed({ maxResults: 25 });
  },
};

let dirty = new Set<Part>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;

/** Coalesce bursts of browser events (page loads fire many) into one fetch + render. */
function invalidate(...parts: Part[]): void {
  for (const part of parts) dirty.add(part);
  flushTimer ??= setTimeout(flush, 60);
}

async function flush(): Promise<void> {
  const parts = [...dirty];
  dirty = new Set();
  flushTimer = undefined;
  await Promise.all(parts.map((part) => loaders[part]()));
  render();
}

/** Run a browser action; failures (tab already gone, etc.) are logged, never thrown at the UI. */
function act(fn: () => Promise<unknown>): void {
  fn()
    .catch((err) => console.error('[tab-sync]', err))
    .finally(() => invalidate('tabs'));
}

// ---------------------------------------------------------------- helpers

const cls = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(' ');

function windowIds(): number[] {
  return [...new Set(state.tabs.map((t) => t.windowId))].sort((a, b) => a - b);
}

function windowLabel(id: number, ids: number[]): string {
  return `Window ${ids.indexOf(id) + 1}`;
}

function windowBadge(id: number, ids: number[]): string {
  return id === state.windowId ? 'here' : `W${ids.indexOf(id) + 1}`;
}

function pinTab(pin: Pin): Tab | undefined {
  return findPinTab(pin, state.tabs, state.bindings, state.windowId);
}

function pinForTab(tab: Tab): Pin | undefined {
  return state.pins.find((pin) => pinTab(pin)?.id === tab.id);
}

function favicon(pageUrl: string): HTMLElement {
  if (!pageUrl) return h('span', { class: 'fav missing' });
  return h('img', {
    class: 'fav',
    src: faviconUrl(pageUrl),
    alt: '',
    width: 16,
    height: 16,
    onerror: (e: Event) => (e.currentTarget as HTMLElement).replaceWith(h('span', { class: 'fav missing' })),
  });
}

function titleEl(text: string, terms: string[]): HTMLElement {
  const parts = highlight(text, terms).map((s) => (s.hit ? h('mark', {}, s.text) : s.text));
  return h('span', { class: 'title' }, ...parts);
}

function link(label: string, run: () => void): HTMLElement {
  return h('button', { class: 'link', onclick: (e: Event) => (e.stopPropagation(), run()) }, label);
}

function rowButton(label: string, run: () => void, className = 'btn', title?: string): HTMLElement {
  return h('button', { class: className, title, onclick: (e: Event) => (e.stopPropagation(), run()) }, label);
}

function section(
  opts: { title: string; key?: string; action?: HTMLElement | false },
  rows: () => Node[],
): HTMLElement {
  const { key } = opts;
  const collapsed = key !== undefined && state.collapsed.has(key);
  const toggle = () => {
    if (!key) return;
    if (state.collapsed.has(key)) state.collapsed.delete(key);
    else state.collapsed.add(key);
    render();
  };
  return h(
    'section',
    { class: cls('sec', collapsed && 'collapsed') },
    h(
      'div',
      { class: cls('sec-h', key && 'toggle'), onclick: key ? toggle : undefined },
      h('span', {}, `${key ? (collapsed ? '▸ ' : '▾ ') : ''}${opts.title}`),
      opts.action,
    ),
    !collapsed && h('div', { class: 'rows' }, ...rows()),
  );
}

// ---------------------------------------------------------------- rows

function tabRow(tab: Tab, ids: number[], terms: string[], showWindow: boolean): HTMLElement {
  const here = tab.windowId === state.windowId;
  const url = tabUrl(tab);
  const id = tab.id!;
  const go = () => act(() => (here ? chrome.tabs.update(id, { active: true }) : goTo(tab)));
  const pull = here ? undefined : () => act(() => bringHere([id], state.windowId));
  const close = () => act(() => chrome.tabs.remove(id));

  const row = h(
    'div',
    {
      class: cls('row', here && tab.active && 'active', tab.discarded && 'sleeping'),
      title: `${tab.title ?? ''}\n${url}`,
      onclick: go,
      onmousedown: (e: MouseEvent) => e.button === 1 && e.preventDefault(),
      onauxclick: (e: MouseEvent) => e.button === 1 && close(),
      oncontextmenu: (e: MouseEvent) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, tabMenu(tab, ids));
      },
    },
    favicon(url),
    titleEl(tab.title || url, terms),
    h(
      'span',
      { class: 'meta' },
      tab.audible && h('span', { class: 'badge', title: 'Playing audio' }, '♪'),
      tab.discarded && h('span', { class: 'badge', title: 'Sleeping' }, 'zz'),
      showWindow ? h('span', { class: 'badge' }, windowBadge(tab.windowId, ids)) : !tab.discarded && hostname(url),
    ),
    h(
      'span',
      { class: 'acts' },
      !here && rowButton('Go ↗', go, 'btn', 'Switch to this tab in its window'),
      pull && rowButton('Here ⇣', pull, 'btn', 'Move this tab into this window'),
      rowButton('✕', close, 'x', 'Close tab'),
    ),
  );
  nav.push({ el: row, go, here: pull });
  return row;
}

function tabMenu(tab: Tab, ids: number[]): MenuItem[] {
  const id = tab.id!;
  const here = tab.windowId === state.windowId;
  const pin = pinForTab(tab);
  const otherWindows = ids.filter((w) => w !== tab.windowId && w !== state.windowId);
  return [
    ...(here
      ? []
      : [
          { label: 'Bring to this window', kbd: '⇧↵', run: () => act(() => bringHere([id], state.windowId)) },
          { label: 'Go to tab', kbd: '↵', run: () => act(() => goTo(tab)) },
        ]),
    ...otherWindows.map((w) => ({
      label: `Move to ${windowLabel(w, ids)}`,
      run: () => act(() => chrome.tabs.move(id, { windowId: w, index: -1 })),
    })),
    { label: 'Move to new window', run: () => act(() => chrome.windows.create({ tabId: id })) },
    '-',
    pin
      ? { label: 'Unpin from all windows', run: () => act(() => removePin(pin.id)) }
      : { label: 'Pin to all windows', run: () => act(() => addPin(tab)) },
    {
      label: 'Sleep tab',
      disabled: tab.active || tab.discarded,
      run: () => act(() => chrome.tabs.discard(id)),
    },
    { label: 'Duplicate', run: () => act(() => chrome.tabs.duplicate(id)) },
    '-',
    { label: 'Close tab', run: () => act(() => chrome.tabs.remove(id)) },
  ];
}

const STATE_GLYPH = { here: '●', elsewhere: '◐', closed: '○' } as const;

function pinStateLabel(tab: Tab | undefined, ids: number[]): string {
  const st = pinState(tab, state.windowId);
  if (st === 'here') return 'open here';
  if (st === 'elsewhere') return `in ${windowLabel(tab!.windowId, ids)}`;
  return 'not open';
}

function pinMenu(pin: Pin, tab: Tab | undefined): MenuItem[] {
  return [
    { label: 'Open here', kbd: '↵', run: () => act(() => openPin(pin, tab, state.windowId)) },
    '-',
    { label: 'Unpin from all windows', run: () => act(() => removePin(pin.id)) },
    ...(tab?.id !== undefined ? [{ label: 'Close tab', run: () => act(() => chrome.tabs.remove(tab.id!)) }] : []),
  ];
}

function pinTile(pin: Pin, ids: number[]): HTMLElement {
  const tab = pinTab(pin);
  const st = pinState(tab, state.windowId);
  const open = () => act(() => openPin(pin, tab, state.windowId));
  const remove = () => act(() => removePin(pin.id));
  const tile = h(
    'button',
    {
      class: cls('pin', st === 'here' && tab?.active && 'current'),
      title: `${pin.title}\n${pinStateLabel(tab, ids)}`,
      onclick: state.editingPins ? remove : open,
      oncontextmenu: (e: MouseEvent) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, pinMenu(pin, tab));
      },
    },
    favicon(pin.url),
    h('span', { class: 'state' }, STATE_GLYPH[st]),
    state.editingPins && h('span', { class: 'remove', 'aria-label': 'Unpin' }, '✕'),
  );
  nav.push({ el: tile, go: state.editingPins ? remove : open });
  return tile;
}

function pinRow(pin: Pin, ids: number[], terms: string[]): HTMLElement {
  const tab = pinTab(pin);
  const st = pinState(tab, state.windowId);
  const open = () => act(() => openPin(pin, tab, state.windowId));
  const row = h(
    'div',
    {
      class: 'row',
      title: pin.url,
      onclick: open,
      oncontextmenu: (e: MouseEvent) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, pinMenu(pin, tab));
      },
    },
    h('span', { class: cls('dot', st) }),
    favicon(pin.url),
    titleEl(pin.title, terms),
    h('span', { class: 'meta' }, pinStateLabel(tab, ids)),
  );
  nav.push({ el: row, go: open, here: open });
  return row;
}

function closedRow(session: Session, terms: string[]): HTMLElement {
  const { tab, window: win } = session;
  const sessionId = tab?.sessionId ?? win?.sessionId;
  const restore = () => act(() => chrome.sessions.restore(sessionId));
  const text = tab ? tab.title || tab.url || '' : `Window · ${win?.tabs?.length ?? 0} tabs`;
  const row = h(
    'div',
    { class: 'row', title: tab?.url ?? '', onclick: restore },
    favicon(tab?.url ?? ''),
    titleEl(text, terms),
    h('span', { class: 'meta' }, timeAgo(session.lastModified * 1000)),
  );
  nav.push({ el: row, go: restore });
  return row;
}

// ---------------------------------------------------------------- views

async function pinActiveTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, windowId: state.windowId });
  if (tab) await addPin(tab);
}

function pinsSection(ids: number[]): HTMLElement {
  const toggleEdit = () => {
    state.editingPins = !state.editingPins;
    render();
  };
  return h(
    'section',
    { class: 'sec' },
    h(
      'div',
      { class: 'sec-h' },
      h('span', {}, 'Pinned · all windows'),
      state.pins.length > 0 && link(state.editingPins ? 'Done' : 'Edit', toggleEdit),
    ),
    h(
      'div',
      { class: 'pins' },
      ...state.pins.map((pin) => pinTile(pin, ids)),
      !state.editingPins &&
        h('button', { class: 'pin add', title: 'Pin the current tab to all windows', onclick: () => act(pinActiveTab) }, '+'),
    ),
    state.pins.length === 0 &&
      h('div', { class: 'empty' }, 'Press + or right-click a tab to pin it. Pins show in every window.'),
  );
}

function renderBrowse(out: DocumentFragment): void {
  const ids = windowIds();
  const byWindow = new Map<number, Tab[]>();
  for (const tab of state.tabs) {
    const list = byWindow.get(tab.windowId);
    if (list) list.push(tab);
    else byWindow.set(tab.windowId, [tab]);
  }
  const here = byWindow.get(state.windowId) ?? [];

  out.append(pinsSection(ids));
  out.append(
    section(
      {
        title: `This window · ${here.length}`,
        action: link('+ New tab', () => act(() => chrome.tabs.create({ windowId: state.windowId }))),
      },
      () => here.map((t) => tabRow(t, ids, [], false)),
    ),
  );
  for (const id of ids) {
    if (id === state.windowId) continue;
    const tabs = byWindow.get(id) ?? [];
    out.append(
      section(
        {
          key: `w:${id}`,
          title: `${windowLabel(id, ids)} · ${tabs.length}`,
          action: link('Bring all here', () =>
            act(() => bringHere(tabs.map((t) => t.id!), state.windowId, false)),
          ),
        },
        () => tabs.map((t) => tabRow(t, ids, [], false)),
      ),
    );
  }
  if (state.closed.length > 0) {
    out.append(
      section({ key: 'closed', title: `Recently closed · ${state.closed.length}` }, () =>
        state.closed.map((s) => closedRow(s, [])),
      ),
    );
  }
}

function renderSearch(out: DocumentFragment, terms: string[]): void {
  const ids = windowIds();
  const tabs = state.tabs
    .filter((t) => matches(terms, t.title, tabUrl(t)))
    // Current window first; otherwise keep window/tab order.
    .sort((a, b) => Number(b.windowId === state.windowId) - Number(a.windowId === state.windowId));
  const pins = state.pins.filter((p) => matches(terms, p.title, p.url));
  const closed = state.closed.filter((s) => s.tab && matches(terms, s.tab.title, s.tab.url));

  if (tabs.length) {
    out.append(section({ title: `Open tabs · ${tabs.length}` }, () => tabs.map((t) => tabRow(t, ids, terms, true))));
  }
  if (pins.length) {
    out.append(section({ title: `Pinned · ${pins.length}` }, () => pins.map((p) => pinRow(p, ids, terms))));
  }
  if (closed.length) {
    out.append(
      section({ title: `Recently closed · ${closed.length}` }, () => closed.map((s) => closedRow(s, terms))),
    );
  }
  if (!tabs.length && !pins.length && !closed.length) {
    out.append(h('div', { class: 'empty' }, `No tabs or pins match “${state.query}”.`));
  }
}

function render(): void {
  const terms = queryTerms(state.query);
  nav = [];
  const out = document.createDocumentFragment();
  if (terms.length) renderSearch(out, terms);
  else renderBrowse(out);

  const scrollTop = $list.scrollTop;
  $list.replaceChildren(out);
  $list.scrollTop = scrollTop;

  state.selected = Math.min(state.selected, nav.length - 1);
  applySelection(false);

  const sleeping = state.tabs.filter((t) => t.discarded).length;
  const windows = windowIds().length;
  $foot.replaceChildren(
    h(
      'span',
      {},
      terms.length
        ? '↑↓ select · ↵ go · ⇧↵ bring here · esc clear'
        : `${state.tabs.length} tabs · ${windows} window${windows === 1 ? '' : 's'} · ${sleeping} sleeping`,
    ),
  );
  $qHint.textContent = state.query ? 'esc' : '⌘K';
}

// ---------------------------------------------------------------- selection + keyboard

function applySelection(scroll = true): void {
  nav.forEach((item, i) => item.el.classList.toggle('selected', i === state.selected));
  if (scroll) nav[state.selected]?.el.scrollIntoView({ block: 'nearest' });
}

function setQuery(query: string): void {
  if ($q.value !== query) $q.value = query;
  state.query = query.trim();
  state.selected = state.query ? 0 : -1;
  render();
  $list.scrollTop = 0;
}

$q.addEventListener('input', () => setQuery($q.value));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$menu.hidden) return closeMenu();
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    $q.focus();
    $q.select();
    return;
  }
  switch (e.key) {
    case 'ArrowDown':
    case 'ArrowUp': {
      e.preventDefault();
      if (nav.length === 0) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      state.selected =
        state.selected < 0 ? (step > 0 ? 0 : nav.length - 1) : (state.selected + step + nav.length) % nav.length;
      applySelection();
      return;
    }
    case 'Enter': {
      const item = nav[state.selected];
      if (!item) return;
      e.preventDefault();
      (e.shiftKey && item.here ? item.here : item.go)();
      if (state.query) setQuery('');
      return;
    }
    case 'Escape':
      if (state.query) setQuery('');
      else {
        state.selected = -1;
        applySelection(false);
      }
      return;
  }
  // Type anywhere to search.
  if (document.activeElement !== $q && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) $q.focus();
});

// ---------------------------------------------------------------- context menu

function openMenu(x: number, y: number, items: MenuItem[]): void {
  $menu.replaceChildren(
    ...items.map((item) =>
      item === '-'
        ? h('hr')
        : h(
            'button',
            {
              role: 'menuitem',
              disabled: item.disabled,
              onclick: () => {
                closeMenu();
                item.run();
              },
            },
            h('span', {}, item.label),
            item.kbd && h('span', { class: 'kbd' }, item.kbd),
          ),
    ),
  );
  $menu.hidden = false;
  const { width, height } = $menu.getBoundingClientRect();
  $menu.style.left = `${Math.max(4, Math.min(x, innerWidth - width - 4))}px`;
  $menu.style.top = `${Math.max(4, Math.min(y, innerHeight - height - 4))}px`;
}

function closeMenu(): void {
  $menu.hidden = true;
}

document.addEventListener('mousedown', (e) => {
  if (!$menu.contains(e.target as Node)) closeMenu();
});
window.addEventListener('blur', closeMenu);
$list.addEventListener('scroll', closeMenu, { passive: true });

// ---------------------------------------------------------------- boot

function subscribe(): void {
  const onTabs = () => invalidate('tabs');
  chrome.tabs.onCreated.addListener(onTabs);
  chrome.tabs.onRemoved.addListener(onTabs);
  chrome.tabs.onMoved.addListener(onTabs);
  chrome.tabs.onAttached.addListener(onTabs);
  chrome.tabs.onDetached.addListener(onTabs);
  chrome.tabs.onActivated.addListener(onTabs);
  chrome.tabs.onReplaced.addListener(onTabs);
  // Page loads fire many updates (status, etc.); only re-render for what we show.
  chrome.tabs.onUpdated.addListener((_id, info) => {
    if ('title' in info || 'url' in info || 'discarded' in info || 'audible' in info || 'favIconUrl' in info) {
      invalidate('tabs');
    }
  });
  chrome.sessions.onChanged.addListener(() => invalidate('closed'));
  chrome.storage.onChanged.addListener((changes) => {
    if (isPinStorageChange(changes)) invalidate('pins');
  });
}

async function init(): Promise<void> {
  state.windowId = (await chrome.windows.getCurrent()).id!;
  subscribe();
  await Promise.all(Object.values(loaders).map((load) => load()));
  render();
  $list.querySelector('.row.active')?.scrollIntoView({ block: 'nearest' });
}

init().catch((err) => {
  console.error('[tab-sync]', err);
  $list.replaceChildren(h('div', { class: 'empty' }, `Tab Sync failed to start: ${String(err)}`));
});

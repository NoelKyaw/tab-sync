import { normalizeUrl, tabUrl, type Bindings, type Pin } from './match.ts';

// Pins persist on disk (storage.local). Pin -> tab bindings live in
// storage.session: shared by every window's panel, in memory only, and
// cleared when the browser quits (tab ids don't survive a restart anyway).
const PINS_KEY = 'pins';
const BINDINGS_KEY = 'pinBindings';

export async function loadPins(): Promise<Pin[]> {
  const data = await chrome.storage.local.get(PINS_KEY);
  return (data[PINS_KEY] as Pin[] | undefined) ?? [];
}

async function savePins(pins: Pin[]): Promise<void> {
  await chrome.storage.local.set({ [PINS_KEY]: pins });
}

export async function loadBindings(): Promise<Bindings> {
  const data = await chrome.storage.session.get(BINDINGS_KEY);
  return (data[BINDINGS_KEY] as Bindings | undefined) ?? {};
}

export async function bindPin(pinId: string, tabId: number): Promise<void> {
  const bindings = await loadBindings();
  if (bindings[pinId] === tabId) return;
  // A tab can only back one pin.
  for (const [id, boundTab] of Object.entries(bindings)) {
    if (boundTab === tabId) delete bindings[id];
  }
  bindings[pinId] = tabId;
  await chrome.storage.session.set({ [BINDINGS_KEY]: bindings });
}

/** Re-point bindings when Chrome swaps a tab id (e.g. after discard/prerender). */
export async function replaceBoundTab(oldTabId: number, newTabId: number): Promise<void> {
  const bindings = await loadBindings();
  let changed = false;
  for (const [id, tabId] of Object.entries(bindings)) {
    if (tabId === oldTabId) {
      bindings[id] = newTabId;
      changed = true;
    }
  }
  if (changed) await chrome.storage.session.set({ [BINDINGS_KEY]: bindings });
}

export async function addPin(tab: chrome.tabs.Tab): Promise<void> {
  const url = tabUrl(tab);
  if (!url) return;
  const pins = await loadPins();
  const existing = pins.find((p) => normalizeUrl(p.url) === normalizeUrl(url));
  const pin = existing ?? { id: crypto.randomUUID(), url, title: tab.title || url };
  if (!existing) await savePins([...pins, pin]);
  if (tab.id !== undefined) await bindPin(pin.id, tab.id);
}

export async function removePin(pinId: string): Promise<void> {
  const pins = await loadPins();
  await savePins(pins.filter((p) => p.id !== pinId));
  const bindings = await loadBindings();
  if (pinId in bindings) {
    delete bindings[pinId];
    await chrome.storage.session.set({ [BINDINGS_KEY]: bindings });
  }
}

export function isPinStorageChange(changes: Record<string, unknown>): boolean {
  return PINS_KEY in changes || BINDINGS_KEY in changes;
}

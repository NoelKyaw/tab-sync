// Pure helpers (no chrome.* calls) so they can be unit-tested in Node.

export interface Pin {
  id: string;
  url: string;
  title: string;
}

/** pinId -> tabId of the live tab that "is" that pin. */
export type Bindings = Record<string, number>;

export interface TabLike {
  id?: number;
  windowId: number;
  url?: string;
  pendingUrl?: string;
  title?: string;
}

export type PinState = 'here' | 'elsewhere' | 'closed';

/** Scheme + host + path, without query, hash or trailing slash. */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url;
  }
}

export function tabUrl(tab: TabLike): string {
  return tab.url || tab.pendingUrl || '';
}

/**
 * Find the live tab for a pin. A bound tab wins (it may have navigated away
 * from the pinned URL, like Arc). Otherwise fall back to an exact URL match,
 * preferring the current window.
 */
export function findPinTab<T extends TabLike>(
  pin: Pin,
  tabs: readonly T[],
  bindings: Bindings,
  windowId: number,
): T | undefined {
  const boundId = bindings[pin.id];
  if (boundId !== undefined) {
    const bound = tabs.find((t) => t.id === boundId);
    if (bound) return bound;
  }
  const key = normalizeUrl(pin.url);
  const matches = tabs.filter((t) => normalizeUrl(tabUrl(t)) === key);
  return matches.find((t) => t.windowId === windowId) ?? matches[0];
}

export function pinState(tab: TabLike | undefined, windowId: number): PinState {
  if (!tab) return 'closed';
  return tab.windowId === windowId ? 'here' : 'elsewhere';
}

export function queryTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Every term must appear in the title or URL. */
export function matches(terms: readonly string[], title = '', url = ''): boolean {
  if (terms.length === 0) return true;
  const hay = `${title}\n${url}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

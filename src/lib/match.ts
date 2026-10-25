// Pure helpers (no chrome.* calls) so they can be unit-tested in Node.

export interface TabLike {
  url?: string;
  pendingUrl?: string;
}

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

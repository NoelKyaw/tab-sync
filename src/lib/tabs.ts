/** The browser's cached favicon for a page. Needs the "favicon" permission. */
export function faviconUrl(pageUrl: string, size = 32): string {
  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', pageUrl);
  url.searchParams.set('size', String(size));
  return url.toString();
}

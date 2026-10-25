import type { Pin } from './match.ts';
import { bindPin } from './pins.ts';

type Tab = chrome.tabs.Tab;

/** Switch to a tab in whatever window it lives in. */
export async function goTo(tab: Tab): Promise<void> {
  if (tab.id === undefined) return;
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

/** Move tabs into `windowId` (appended at the end). Optionally activate the first one. */
export async function bringHere(tabIds: number[], windowId: number, activate = true): Promise<void> {
  if (tabIds.length === 0) return;
  await chrome.tabs.move(tabIds, { windowId, index: -1 });
  if (activate) await chrome.tabs.update(tabIds[0]!, { active: true });
}

/** Arc-style pin click: switch to it here, pull it here, or open it here. Never duplicates. */
export async function openPin(pin: Pin, liveTab: Tab | undefined, windowId: number): Promise<void> {
  if (liveTab?.id !== undefined) {
    if (liveTab.windowId === windowId) await chrome.tabs.update(liveTab.id, { active: true });
    else await bringHere([liveTab.id], windowId);
    await bindPin(pin.id, liveTab.id);
    return;
  }
  const created = await chrome.tabs.create({ windowId, url: pin.url, active: true });
  if (created.id !== undefined) await bindPin(pin.id, created.id);
}

export function faviconUrl(pageUrl: string, size = 32): string {
  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', pageUrl);
  url.searchParams.set('size', String(size));
  return url.toString();
}

// Service worker. Event-driven only: it holds no state and Chrome shuts it
// down when idle. All UI lives in the side panel, which exists only while open.
import { replaceBoundTab } from './lib/pins.ts';

// Dia/Chromium builds without the Side Panel API fall back to a toolbar popup.
const hasSidePanel = typeof chrome.sidePanel?.setPanelBehavior === 'function';

function configureAction(): void {
  if (hasSidePanel) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
  } else {
    chrome.action.setPopup({ popup: 'sidepanel.html?mode=popup' }).catch(console.error);
  }
}

chrome.runtime.onInstalled.addListener(configureAction);
chrome.runtime.onStartup.addListener(configureAction);

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'open-panel') return;
  // Must be called synchronously inside the user gesture.
  if (hasSidePanel && tab) chrome.sidePanel.open({ windowId: tab.windowId }).catch(console.error);
  else chrome.action.openPopup?.().catch(console.error);
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  replaceBoundTab(removedTabId, addedTabId).catch(console.error);
});

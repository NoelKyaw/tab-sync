# Tab Sync

An Arc-style side panel for [Dia](https://www.diabrowser.com) (works in any Chromium browser with the Side Panel API).

- **All windows in one place.** The panel lists this window's tabs first, then every other window's.
- **Bring it here.** Pull a tab from another window into this one (`Here ⇣`, or `⇧↵` in search) instead of hunting for it.
- **Pins shared across windows.** Pinned tabs show in every window's panel: `●` open here, `◐` open in another window, `○` not open. Clicking a pin switches to it, pulls it here, or opens it, so there's never a duplicate. A pin keeps following its tab after you navigate within it.
- **Search everything** with `⌘K` (or just start typing): open tabs, pins, recently closed.
- **Right-click a tab** to move it to another or new window, pin/unpin, sleep (unload), duplicate, or close. Middle-click closes.

## Install (unpacked)

```sh
npm install
npm run build        # outputs dist/
```

1. In Dia, open `chrome://extensions` and turn on **Developer mode**.
2. **Load unpacked** → select the `dist/` folder.
3. Click the Tab Sync toolbar icon (or press `⌘⇧Y`) to open the panel. Change the shortcut at `chrome://extensions/shortcuts`.

During development, `npm run watch` rebuilds on save; reload the extension on the extensions page to pick up background changes (the panel picks up changes when reopened).

## Privacy and memory

- **Local only.** No network permissions, no host permissions, no remote code, no `storage.sync`. Pins live in `chrome.storage.local`; pin↔tab bindings live in in-memory `chrome.storage.session`.
- **Nothing injected into pages.** No content scripts, so your tabs carry no extra weight.
- **No idle cost.** The background service worker only handles the shortcut and is shut down by the browser when idle. The panel exists only while open; it asks the browser for the tab list instead of keeping its own copy, and coalesces bursts of tab events into one render.
- **Favicons** come from the browser's own cache (`_favicon`), never stored by the extension.
- Measured with 308 open tabs: ~15 ms per full re-render, ~10 MB panel JS heap.

## Development

```sh
npm run typecheck
npm test             # unit tests for URL matching, search, text helpers (node:test)
```

| Path | What |
|---|---|
| `src/manifest.json` | MV3 manifest |
| `src/background.ts` | Service worker: panel behavior, shortcut, tab-id replacement |
| `src/sidepanel/` | Panel UI (vanilla TS, no framework) |
| `src/lib/match.ts` | Pure logic: URL normalization, pin→tab matching, search |
| `src/lib/pins.ts` | Pin storage and bindings |
| `src/lib/tabs.ts` | Tab actions: go to, bring here, open pin |
| `wireframes/side-panel.html` | The original black-and-white wireframe |

## Not in v1 yet

- Searchable local history (IndexedDB, capped by count/age)
- Auto-sleep inactive tabs after N minutes, and the settings screen
- Drag to reorder pins

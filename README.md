# Tab Sync

Arc-style tabs for [Dia](https://www.diabrowser.com) (and any Chromium browser): **every window shows the same regular tabs, in the same order**, right in the browser's own tab bar. There's no extra panel or sidebar.

Only regular tabs are synced. Dia's **Favorites** (the icon grid) and **Pinned** tabs are never copied, moved or closed; Dia already shares those across a profile's windows.

## How it works

A page can only be open in one window at a time, so Tab Sync never loads a page twice:

- The window where you're using a page holds the **live tab**. Every other window holds a **stand-in** in the same spot, with the same title and icon.
- Stand-ins are **unloaded** as soon as they're created, so they use almost no memory.
- **Switching to a stand-in** pulls the live tab into this window, with scroll position, form input and video intact. The stand-in goes back to where the live tab was.

What's mirrored to every window:

| You… | Every other window… |
|---|---|
| open a tab (once it has loaded) | gets it in the same spot |
| navigate a tab to another page | follows |
| drag tabs to reorder them | matches the new order |
| close a tab | closes it too |
| pin a tab (drag it into Pinned) | drops its copy. The page leaves sync and stays pinned where you put it. If you pinned a stand-in, the real page moves there. |
| unpin a tab | gets it, because it's a regular synced tab again |
| close a **window** | keeps everything. Pages that were live there reload when you open them. |
| open a new window | it fills with every synced tab |

New-tab pages and browser pages (`chrome://…`) stay per-window until you go to a real site. Tab groups and incognito windows aren't synced.

**Profiles:** each Dia profile runs its own copy of the extension, so each profile syncs its own windows and never mixes with another profile. Load the extension in every profile you want synced.

**Upgrading from v0.2:** v0.2 also synced pinned tabs, which left copies of Favorites and Pinned items in other windows. On first run, v0.3 closes those copies. It only closes stand-ins, never real pages.

**On/off:** click the Tab Sync toolbar icon to pause; the badge shows `off`. Pausing closes stand-ins whose page is open somewhere else. Clicking the icon again re-syncs every window.

## Install (unpacked)

```sh
npm install
npm run build        # outputs dist/
```

1. In Dia, open `chrome://extensions` and turn on **Developer mode**.
2. **Load unpacked** → select the `dist/` folder.

Sync starts right away and merges the tabs of all open windows. Pin the toolbar icon if you want the on/off switch handy.

## Privacy and memory

- **Local only.** No network permissions, no host permissions, no remote code. State lives in `chrome.storage.session` (in memory) and `chrome.storage.local` (the tab order, so it survives a restart).
- **Nothing injected into pages.** No content scripts.
- **No idle cost.** The background service worker only wakes for tab and window events, and the browser shuts it down when idle.
- **Stand-ins are `data:` pages, not extension pages.** Unloading an extension page also takes down the extension's own process. Favicons come from the browser's own favicon cache and are embedded in the stand-in.
- **Measured** with 40 tabs mirrored into 3 windows: 80 stand-ins were created and unloaded in about 4 s. They added no renderer processes and about 75 MB to the browser process (≈1 MB per stand-in, Chrome's base cost for any tab). A live copy of a page usually costs 50–300 MB.

## Trade-offs

- With two windows side by side, a page can only be live in one of them. Clicking it in one window pulls it out of the other, and that window shows the stand-in.
- Stand-ins keep the title they had when the live tab last went to a new page. Changing titles, like unread counts, aren't copied, because replacing a stand-in is visible in the tab bar.
- Dia features that read your tabs, like chatting with tabs, see stand-ins as placeholder pages until you open them.

## Development

```sh
npm run typecheck
npm test             # unit tests for the sync model (node:test)
```

| Path | What |
|---|---|
| `src/manifest.json` | MV3 manifest |
| `src/background.ts` | Service worker entry |
| `src/sync/model.ts` | Pure logic: shared order, per-window plans, swaps, stand-in URLs |
| `src/sync/engine.ts` | Chrome glue: events, serial reconcile queue, swaps, on/off |
| `src/lib/` | URL and favicon helpers |

v0.1 was a side panel. It's in the git history at `a5babbc`.

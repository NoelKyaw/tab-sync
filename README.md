# Tab Sync

Arc-style tabs for Chromium browsers: **every window shows the same regular tabs, in the same order**, right in the browser's own tab bar. There's no extra panel or sidebar.

> **Status: parked. It doesn't work in Dia yet.** The sync engine works and is tested in Chrome for Testing. Dia, the browser it was built for, doesn't give extensions enough information to sync tabs per profile, so in Dia it mixes tabs between profiles. Keep it paused or uninstalled in Dia. See [Why it doesn't work in Dia](#why-it-doesnt-work-in-dia) for the findings, what Dia would need to expose, and how to re-check.
>
> `master` holds v0.1, the read-only side panel. This branch holds v0.2 and v0.3, the tab-bar sync.

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
| pin a tab | drops its copy. The page leaves sync and stays pinned where you put it. If you pinned a stand-in, the real page moves there. |
| unpin a tab | gets it, because it's a regular synced tab again |
| close a **window** | keeps everything. Pages that were live there reload when you open them. |
| open a new window | it fills with every synced tab |

Pinned tabs, new-tab pages, browser pages (`chrome://…`), tab groups and incognito windows aren't synced.

**On/off:** click the toolbar icon to pause; the badge shows `off`. Pausing closes stand-ins whose page is open somewhere else. Clicking the icon again re-syncs every window.

## Why it doesn't work in Dia

This section records what we found by inspecting Dia from inside an extension (the service-worker console and the probe in `tools/dia-probe/`). Dia was version 1.54.x at the time.

### What Dia shows an extension

1. **All profiles share one window.** When you switch profiles inside a Dia window (the dots at the bottom of the sidebar), the extension still sees one browser window. Every profile's tabs are in it, interleaved. A second Dia window is a second browser window, again with every profile's tabs in it.
2. **There's one copy of the extension for all profiles.** Opening the service-worker console from another profile opened the same console: same extension id, same windows, same storage.
3. **Nothing on a tab says which profile it belongs to.** Tabs only have Chrome's standard fields (`id`, `windowId`, `index`, `pinned`, `groupId`, `url`, `title`, `active`, `discarded`, `frozen`, `splitViewId`, …).
4. **There's one cookie store.** `chrome.cookies.getAllCookieStores()` puts every tab in store `"0"`, even when profiles are signed in to different accounts. Cookies can't tell profiles apart.
5. **The sidebar sections aren't exposed.**
   - Favorites (the icon grid) and Pinned items report `pinned: false`, the same as regular tabs.
   - Tabs inside a Pinned folder carry a `groupId`, but `chrome.tabGroups.query()` returns no groups, so it's Dia's own numbering. Loose Pinned items and Favorites have `groupId: -1`, the same as regular tabs.
6. **There are no Dia-specific extension APIs.** `Object.keys(chrome)` lists only the standard namespaces for the granted permissions. `chrome.tabs` is standard Chrome, plus `createSplit`/`unsplit` for split view.
7. **An extension can't choose a profile for a new tab.** Dia puts a tab created by an extension into whichever profile the window is showing.

### What goes wrong

Tab Sync sees one list of tabs per window, mixing every profile and every sidebar section. It mirrors all of them, and Dia files the copies under whichever profile each window is showing. The result:
- other profiles' tabs show up in a new window's profile;
- Favorites and Pinned items show up as regular tabs.

v0.3 ignores pinned tabs, which works in browsers that mark them, but Dia doesn't mark them, so that change has no effect in Dia.

### What Dia would need to expose

Either of these would unblock it. The engine is ready for either.

- **A profile id on each tab, and a way to create a tab in a given profile.** Sync would then key every tab by profile, and only fill a window with a profile's tabs when that window shows that profile.
- **A section marker** (Favorites / Pinned / regular), or Dia reporting Favorites and Pinned as `pinned: true`. That lets sync skip sections 1 and 2.

Alternatively, Dia could build Arc-style tab sharing across windows itself.

### Re-checking a future Dia version

1. Load `tools/dia-probe/` unpacked in Dia (`chrome://extensions` → Developer mode → **Load unpacked**). It only reads: it never changes tabs, reads cookie values, or sends anything.
2. Click its toolbar icon. The report lists, for every tab, its window, group, folder title and cookie store, plus all cookie stores and tab groups.
3. Look for any field that separates profiles or sidebar sections. Also run `Object.keys(chrome)` in its service-worker console to look for new APIs.

If something reliable turns up, the place to use it is `deriveModel` / `planWindow` in `src/sync/model.ts`. Key sids by profile, and treat non-regular sections like pinned tabs are treated now.

## Install (unpacked)

```sh
npm install
npm run build        # outputs dist/
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. **Load unpacked** → select the `dist/` folder.

Sync starts right away and merges the tabs of all open windows. In Dia, read the status note above first.

## Privacy and memory

- **Local only.** No network permissions, no host permissions, no remote code. State lives in `chrome.storage.session` (in memory) and `chrome.storage.local` (the tab order plus a schema version, so it survives a restart).
- **Nothing injected into pages.** No content scripts.
- **No idle cost.** The background service worker only wakes for tab and window events, and the browser shuts it down when idle. Title-only changes are ignored, so pages with ticking titles don't keep it awake.
- **Measured** with 40 tabs mirrored into 3 windows: 80 stand-ins were created and unloaded in about 4 s. They added no renderer processes and about 75 MB to the browser process (≈1 MB per stand-in, Chrome's base cost for any tab). A live copy of a page usually costs 50–300 MB.

## Browser behavior this design depends on

These came out of testing in Chrome for Testing 147, and each one shaped the code:

- **Stand-ins are `data:` pages.**
  - Discarding a tab that shows an extension page takes down the extension's own process: the service worker stops answering, even its own timers. So stand-ins can't be extension pages.
  - Favicons are read from the browser's favicon cache (`_favicon`) and embedded in the stand-in.
  - A discarded `data:` tab keeps its title, favicon and tab id.
- **Stale stand-ins are replaced.** `chrome.tabs.update()` to a `data:` URL is silently ignored, so a stand-in can't be navigated. It's created anew and the old one closed. That's visible in the tab bar, so it only happens when the live tab goes to a different page, not on title changes.
- **Moving a pinned tab to another window unpins it.** That's why pinning a stand-in moves the live tab there and pins it again afterwards.
- **One window counts as focused.** Swaps happen only for the window from the latest `windows.onFocusChanged` event, with a 1 s cooldown per tab. Without that, two windows could pull the same tab back and forth forever.
  - Headless Chrome reports every window as `focused: true`, and `windows.update({focused})` sends no focus event. The e2e tests work around this.
- **Tabs can vanish mid-operation.** "No tab with id …" and "Tabs cannot be edited right now" (while dragging) mean a tab changed between reading and acting. They're logged at debug level, and a fresh sync pass follows and tidies up.
- **Window closes are double-checked.** Closing a window must never close its tabs elsewhere. On top of `isWindowClosing`, the engine checks the window still exists before treating a removal as "the user closed this tab".

## Trade-offs

- With two windows side by side, a page can only be live in one of them. Clicking it in one window pulls it out of the other, and that window shows the stand-in.
- Stand-ins keep the title they had when the live tab last went to a new page. Changing titles, like unread counts, aren't copied.
- Browser features that read your tabs (Dia's chat with tabs, for example) see stand-ins as placeholder pages until you open them.

## Development

```sh
npm run typecheck
npm test             # unit tests for the sync model (node:test)
npm run e2e          # build, then run the end-to-end tests in Chrome for Testing
```

The e2e tests need Chrome for Testing, because branded Chrome ignores `--load-extension`. Install them once:

```sh
npm --prefix e2e install
npx @puppeteer/browsers install chrome@stable --path ~/.cache/puppeteer   # or set CHROME_PATH
```

| Path | What |
|---|---|
| `src/manifest.json` | MV3 manifest |
| `src/background.ts` | Service worker entry |
| `src/sync/model.ts` | Pure logic: shared order, per-window plans, swaps, stand-in URLs, v0.2 cleanup |
| `src/sync/engine.ts` | Chrome glue: events, serial sync queue, swaps, on/off, storage |
| `src/lib/` | URL and favicon helpers |
| `test/` | Unit tests |
| `e2e/sync.mjs` | Main e2e: mirroring, swaps, pinning, closing, new windows, navigation, dragging |
| `e2e/restart.mjs` | Quit and relaunch with session restore: nothing duplicated or lost |
| `e2e/migrate.mjs` | Upgrade from v0.2 state: leftover copies removed, real tabs untouched |
| `e2e/race.mjs` | Tabs closed mid-swap: no errors, windows converge |
| `e2e/stress.mjs` | Memory and timing with many tabs (`npm --prefix e2e run stress`) |
| `tools/dia-probe/` | Read-only diagnostic extension for checking what a browser exposes |

## History

- **v0.1** (`master`): a read-only side panel listing every window's tabs, with pins shared across windows. It works in Dia, but lists all profiles' tabs together.
- **v0.2**: replaced the panel with tab-bar sync using stand-ins.
- **v0.3**: stopped syncing pinned tabs, cleaned up v0.2's copies, and handles tabs vanishing mid-operation.
- **Parked**: Dia doesn't expose profiles or sidebar sections. See above.

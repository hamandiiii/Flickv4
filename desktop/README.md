# CoFFe House — Windows desktop shell

Electron wrapper around the same Expo app that ships to iOS/Android. The
renderer is the web export (`dist-web/`), served from a loopback HTTP server;
the main process only adds what a browser cannot do.

## Why this shape

| Need | Native answer | Desktop answer |
| --- | --- | --- |
| Play `.m3u8` | `react-native-video` (ExoPlayer/AVPlayer) | `hls.js` over MSE — Chromium has no native HLS |
| Scrape stream embeds | `react-native-webview` + `injectedJavaScript` | `<webview>` + CDP `Page.addScriptToEvaluateOnNewDocument` |
| Save downloads | `expo-file-system` + background downloader | Node `fs` in the main process |
| Persist settings | AsyncStorage (SQLite/RocksDB) | AsyncStorage → `localStorage` |

## Files

```
desktop/
  main.js              Electron main: static server, IPC, menus, download engine
  preload.js           window.coffeDesktop bridge (contextIsolation, no node in renderer)
  scraper-bridge.js    CDP injection for <webview> guests
  package.json         electron-builder config (MSI + NSIS)
  build/icon.png       app/installer/tray icon (checked in — un-ignored in .gitignore)
  *-test.js            dev probes, run with the local electron binary
```

Renderer-side platform splits live in `src/` and only apply on web:

- `src/components/player/VideoPlayer.web.tsx` — attaches hls.js to the
  `<video>` that `react-native-video`'s web build renders.
- `src/components/player/ScraperWebView.web.tsx` — `<webview>` host.
- `src/services/DownloadService.web.ts` — job list + local playback URLs.
- `src/hooks/useDesktopStorage.tsx`, `src/screens/StorageSettingsScreen.tsx`.
- `components/ui/*/index.web.tsx` — pass `style` through to the DOM node
  (gluestack's web build dropped it, which broke absolute positioning).

## Two invariants

**1. The loopback port is fixed (`43117`).**

AsyncStorage on web is `localStorage`, scoped to `http://127.0.0.1:<port>`.
An ephemeral port would therefore wipe settings, watchlist, playback progress
and the download list on every launch. On `EADDRINUSE` the shell falls back to
an ephemeral port rather than refusing to start, but that is a degraded mode.

**2. Downloads are served back over HTTP, never `file://`.**

`<storage>/downloads/<job id>/` is mounted at `/__media/<folder>/<file>` with
`Range` support. Chromium will not play HLS from `file://`, and seeking needs
`206 Partial Content`.

HLS jobs are saved as a **rewritten playlist + segment files**, with AES-128
segments decrypted during the download. There is no remux: what was on the CDN
is what lands on disk. Master playlists are followed to the highest-bandwidth
variant **excluding HEVC** (`hev1|hvc1|dvh1|dvhe`), because Chromium cannot
decode HEVC.

## Install layout

The MSI is per-user (`%LOCALAPPDATA%\Programs`) and installs into a folder named
**`CoFFe House stream`** — set via `win.executableName`, which drives both the
EXE name and the WiX `INSTALLDIR` — so it never collides with another project
called "CoFFe House". `productName` stays `CoFFe House`, so the ARP entry,
shortcuts and window title are unchanged.

## Shell features

- **Close to tray.** Closing the window hides it (downloads keep running); the
  tray menu can reopen it, open the storage/downloads folders, or quit. Toggle
  in Settings → Storage location → *Close to tray*; persisted in
  `userData/desktop-settings.json`.
- **Resumable downloads.** A paused/interrupted job keeps its bytes:
  HLS skips segments already on disk, direct files continue from
  `video.<ext>.part` with a `Range: bytes=N-` request (a server that ignores
  the range restarts cleanly rather than appending garbage).
- **Offline subtitles.** After a job completes, the preferred language is
  fetched from the Vdrk catalog (keyless) with Wyzie as a second source and
  written to `<folder>/subs/<lang>.vtt`, served through `/__media/` like the
  video. Soft-fails — the video stays playable without captions.

## Build

```powershell
# 1. web bundle (regenerate after any src/ change)
npx expo export --platform web --output-dir dist-web --clear

# 2. installer
cd desktop
$env:CSC_IDENTITY_AUTO_DISCOVERY='false'
npm run dist:msi     # -> release/CoFFeHouse-Setup-1.1.0.msi
                     #    release/win-unpacked/CoFFe House stream.exe
```

`extraResources` copies `../dist-web` into `resources/web`, so the MSI always
carries the bundle that existed at build time — rebuild the export first.

## Tests

Run with the local Electron binary (there is no display-less mode; each probe
boots the real shell):

```powershell
cd desktop
.\node_modules\electron\dist\electron.exe download-test.js    # 29 checks (incl. resume + subtitles)
.\node_modules\electron\dist\electron.exe playback-test.js    # real HLS playback
.\node_modules\electron\dist\electron.exe persistence-test.js --write
.\node_modules\electron\dist\electron.exe persistence-test.js --read
.\node_modules\electron\dist\electron.exe smoke-test.js
.\node_modules\electron\dist\electron.exe scraper-test.js
node packaged-test.js                                          # the built EXE
```

TypeScript must be run with a bigger stack — `npx tsc` overflows on this
project:

```powershell
node --stack-size=16000 node_modules/typescript/lib/tsc.js --noEmit
```

## Known gaps (v1)

- **No auto-update.** Reinstall the MSI to move versions.
- **No code signing.** Windows SmartScreen will warn on first run
  (*More info → Run anyway*).
- Resume keeps bytes only when the stream URL is unchanged; a job whose server
  URL changed restarts from scratch.

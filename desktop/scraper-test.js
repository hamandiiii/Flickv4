/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Dev-only end-to-end probe for the stream-scraper bridge.
 *
 * It does NOT trust the bridge blindly: it pulls the *real* injected script
 * straight out of `src/components/player/WebViewScraper.tsx`, boots the real
 * main process (IPC + preload), then opens a hidden `<webview>` on a local
 * "embed" page whose very first `<head>` script calls `fetch()`. That is the
 * worst case for injection timing — if the hook is not installed before the
 * page's own JavaScript, the request is missed.
 *
 * The fake API returns the same shape VidLink uses
 * (`{ stream: { playlist } }`), so the probe also covers the JSON walker.
 *
 *   npx electron desktop/scraper-test.js
 */
const { app, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Boot the production shell: registers IPC handlers + preload.
require('./main.js');

/** Extract `buildInjectedJavaScript(...)`'s template literal from the source. */
function extractInjectedScript() {
  const file = path.join(
    __dirname,
    '..',
    'src',
    'components',
    'player',
    'WebViewScraper.tsx',
  );
  const src = fs.readFileSync(file, 'utf8');
  const marker = ') => `';
  const start = src.indexOf(marker);
  if (start === -1) throw new Error('buildInjectedJavaScript template not found');
  const from = start + marker.length;
  const end = src.indexOf('`;', from);
  if (end === -1) throw new Error('template literal end not found');

  const raw = src
    .slice(from, end)
    .replace("${muted ? 'true' : 'false'}", 'false')
    .replace('${timeoutMs}', '15000')
    .replace("${autoTap ? 'true' : 'false'}", 'true');

  const leftover = raw.indexOf('${');
  if (leftover !== -1) {
    throw new Error(
      `unreplaced interpolation at ${leftover}: ${raw.slice(leftover, leftover + 40)}`,
    );
  }

  // The template literal contains escapes (`\\.`, `\\/`, `\``), so it must be
  // evaluated as a template — not used raw — to match what the app really
  // injects.
  const script = new Function(`return \`${raw}\`;`)();
  // Fail loudly here instead of silently on the guest (Chromium swallows
  // syntax errors in preload scripts).
  new Function(script);
  return script;
}

const EMBED_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>fake embed</title>
    <script>
      // Runs before DOMContentLoaded — the hook must already be installed.
      window.__pageRanAt = Date.now();
      fetch('/api/b/1')
        .then(function (r) { return r.json(); })
        .then(function (json) { window.__apiJson = json; });
    </script>
  </head>
  <body>
    <h1>fake embed</h1>
  </body>
</html>`;

const API_JSON = JSON.stringify({
  stream: {
    playlist: 'https://cdn.probe.test/live/master.m3u8',
    requiresProxy: false,
    qualities: {},
  },
});

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const { pathname } = new URL(req.url, 'http://127.0.0.1');
      if (pathname === '/api/b/1') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(API_JSON);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(EMBED_HTML);
    });
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

app.whenReady().then(async () => {
  const script = extractInjectedScript();
  console.log('[script] extracted', script.length, 'chars');

  const port = await startServer();
  console.log('[server] listening on', port);

  let win = null;
  for (let i = 0; i < 200 && !win; i += 1) {
    win = BrowserWindow.getAllWindows()[0] || null;
    if (!win) await sleep(100);
  }
  if (!win) {
    console.log('[fatal] no app window');
    process.exit(1);
    return;
  }

  // The app window must finish loading before we can drive the bridge.
  await sleep(4000);

  const probe = `(async () => {
    const script = ${JSON.stringify(script)};
    const url = 'http://127.0.0.1:${port}/embed.html';

    const el = document.createElement('webview');
    el.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:360px;';
    el.setAttribute('src', 'about:blank');
    document.body.appendChild(el);

    // getWebContentsId() throws until BOTH did-attach and dom-ready have
    // fired, and did-attach alone is not enough on Electron 38.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('guest never attached')), 15000);
      let attached = false;
      let ready = false;
      const done = () => {
        if (attached && ready) {
          clearTimeout(timer);
          resolve();
        }
      };
      el.addEventListener('did-attach', () => { attached = true; done(); }, { once: true });
      el.addEventListener('dom-ready', () => { ready = true; done(); }, { once: true });
    });

    const id = el.getWebContentsId();
    const messages = [];
    const off = window.coffeDesktop.onScraperMessage((payload) => {
      if (payload && payload.id === id) messages.push(payload.data);
    });

    const attached = await window.coffeDesktop.attachScraper(id, script);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('guest never loaded')), 15000);
      el.addEventListener('did-stop-loading', () => { clearTimeout(timer); resolve(); }, { once: true });
      el.setAttribute('src', url);
    });

    // Give the page's own fetch + the walker time to report.
    await new Promise((r) => setTimeout(r, 6000));

    const state = await el.executeJavaScript(
      '({ ranAt: window.__pageRanAt, json: window.__apiJson, found: window.__flickStreamFound, shim: typeof window.ReactNativeWebView, post: typeof (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) })'
    ).catch((error) => ({ error: String(error) }));

    // If the before-load hook did not take, retry manually to separate
    // "script is broken" from "injection timing/target is broken".
    let manual = null;
    if (state.shim === 'undefined') {
      manual = await el.executeJavaScript(script + '\\n;({ shim: typeof window.ReactNativeWebView })')
        .catch((error) => ({ error: String(error) }));
      await new Promise((r) => setTimeout(r, 1500));
    }

    // Direct console probe: proves the console-message -> IPC -> preload path
    // independently of whether the injected hooks matched anything.
    await el.executeJavaScript(
      'console.log("__COFFE_MSG__" + JSON.stringify({ type: "video", responseURL: "https://probe.test/direct.m3u8" }))'
    ).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));

    off();
    return { id, attached, state, manual, messages };
  })()`;

  let result;
  try {
    result = await win.webContents.executeJavaScript(probe);
  } catch (error) {
    console.log('[fatal] probe failed:', error && error.message);
    process.exit(1);
    return;
  }

  console.log('[probe] attached:', result.attached, 'guest id:', result.id);
  console.log('[probe] page state:', JSON.stringify(result.state));
  console.log('[probe] messages:', result.messages.length);
  for (const raw of result.messages) console.log('  <-', raw);

  const parsed = result.messages
    .map((raw) => {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const video = parsed.find(
    (msg) => msg.type === 'video' && /master\.m3u8/.test(msg.responseURL || ''),
  );

  console.log(
    video
      ? `[result] PASS — resolved ${video.responseURL} (isWebM=${video.isWebM})`
      : '[result] FAIL — no video payload was reported',
  );
  fs.writeFileSync(
    path.join(__dirname, 'smoke', 'scraper.log'),
    JSON.stringify(result, null, 2),
    'utf8',
  );
  process.exit(video ? 0 : 1);
});

app.on('window-all-closed', () => app.quit());

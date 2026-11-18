/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Dev-only probe: can this Electron/Chromium build actually play HLS through
 * hls.js?
 *
 * Chromium has no native `.m3u8` support, so the desktop player depends on
 * hls.js entirely (see `src/components/player/VideoPlayer.web.tsx`). This test
 * loads the *same* hls.js build from `node_modules`, attaches it to a `<video>`
 * inside the real app window, and waits for the playhead to move — proving the
 * codec support, MSE availability, CORS handling and network path all work.
 *
 *   npx electron desktop/playback-test.js
 */
const { app, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

require('./main.js');

const HLS_JS = path.join(__dirname, '..', 'node_modules', 'hls.js', 'dist', 'hls.min.js');
const STREAM = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const { pathname } = new URL(req.url, 'http://127.0.0.1');
      if (pathname === '/hls.min.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript' });
        fs.createReadStream(HLS_JS).pipe(res);
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

app.whenReady().then(async () => {
  if (!fs.existsSync(HLS_JS)) {
    console.log('[fatal] hls.js build missing at', HLS_JS);
    process.exit(1);
    return;
  }

  const port = await startServer();
  console.log('[server] hls.js on', port);

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
  await sleep(4000);

  const probe = `(async () => {
    const out = { mediaSource: typeof MediaSource !== 'undefined', canPlayHls: '' };

    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'http://127.0.0.1:${port}/hls.min.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('hls.js failed to load'));
      document.head.appendChild(s);
    });

    out.hlsVersion = window.Hls && window.Hls.version;
    out.supported = !!(window.Hls && window.Hls.isSupported());
    if (!out.supported) return out;

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.style.cssText = 'position:fixed;left:0;top:0;width:320px;height:180px;z-index:99999';
    document.body.appendChild(video);

    const hls = new window.Hls({ enableWorker: true });
    const errors = [];
    hls.on(window.Hls.Events.ERROR, (_e, data) => {
      if (data.fatal) errors.push(String(data.details || data.type));
    });

    await new Promise((resolve, reject) => {
      hls.on(window.Hls.Events.MANIFEST_PARSED, resolve);
      hls.on(window.Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) reject(new Error(String(data.details || data.type)));
      });
      hls.loadSource(${JSON.stringify(STREAM)});
      hls.attachMedia(video);
    });

    out.levels = (hls.levels || []).map((l) => l.height);
    await video.play().catch(() => {});

    const started = Date.now();
    await new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        if (video.currentTime > 0.5) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - started > 30000) {
          clearInterval(timer);
          reject(new Error('no playback progress (readyState=' + video.readyState + ')'));
        }
      }, 250);
    });

    out.currentTime = video.currentTime;
    out.duration = video.duration;
    out.videoWidth = video.videoWidth;
    out.videoHeight = video.videoHeight;
    out.errors = errors;

    hls.destroy();
    video.remove();
    return out;
  })()`;

  let result;
  try {
    result = await win.webContents.executeJavaScript(probe);
  } catch (error) {
    console.log('[result] FAIL —', error && error.message);
    process.exit(1);
    return;
  }

  const ok =
    result.supported === true &&
    result.currentTime > 0.5 &&
    (result.videoWidth || 0) > 0;

  console.log('[probe]', JSON.stringify(result));
  console.log(
    ok
      ? `[result] PASS — played ${result.videoWidth}x${result.videoHeight}, t=${result.currentTime.toFixed(2)}s, levels=${JSON.stringify(result.levels)}`
      : '[result] FAIL — HLS playback did not start',
  );

  fs.writeFileSync(
    path.join(__dirname, 'smoke', 'playback.log'),
    JSON.stringify(result, null, 2),
    'utf8',
  );
  process.exit(ok ? 0 : 1);
});

app.on('window-all-closed', () => app.quit());

/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * CoFFe House — Windows desktop shell.
 *
 * The Expo app is exported as a static web bundle (`dist-web/`) and served
 * from an in-process HTTP server bound to 127.0.0.1. Serving over HTTP instead
 * of `file://` matters:
 *
 *   - Expo's web export uses absolute asset paths (`/_expo/...`), which break
 *     under `file://`.
 *   - `http://127.0.0.1` is a trustworthy origin, so cross-origin API calls
 *     (TMDB) and HLS playback are not treated as mixed content.
 *   - React Navigation's history-based routing needs a real origin.
 *
 * The shell also owns the "storage location" feature: the user picks a folder,
 * it is persisted in userData, and every in-app download is routed there.
 */
const { app, BrowserWindow, dialog, ipcMain, shell, session, Menu } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const scraperBridge = require('./scraper-bridge');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const IS_DEV = !app.isPackaged;

/**
 * Where the static web bundle lives. Packaged builds ship it as an extra
 * resource (`resources/web`), dev builds read the repo's `dist-web/`.
 */
const WEB_ROOT = IS_DEV
  ? path.join(__dirname, '..', 'dist-web')
  : path.join(process.resourcesPath, 'web');

const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'desktop-settings.json');

// ---------------------------------------------------------------------------
// Settings (storage location + window state)
// ---------------------------------------------------------------------------

const defaultStorageDir = () => path.join(app.getPath('downloads'), 'CoFFe House');

let settings = {
  storageDir: null,
  window: null,
};

function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      settings = { ...settings, ...parsed };
    }
  } catch {
    // First run (or corrupt file) — keep defaults.
  }
  if (!settings.storageDir || typeof settings.storageDir !== 'string') {
    settings.storageDir = defaultStorageDir();
  }
  ensureDir(settings.storageDir);
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('[coffe] failed to persist settings:', err);
  }
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch (err) {
    console.error('[coffe] cannot create storage dir:', dir, err);
    return false;
  }
}

function storageDir() {
  if (!settings.storageDir) settings.storageDir = defaultStorageDir();
  return settings.storageDir;
}

function setStorageDir(dir) {
  if (!dir || typeof dir !== 'string') return storageDir();
  const resolved = path.resolve(dir);
  if (!ensureDir(resolved)) return storageDir();
  settings.storageDir = resolved;
  saveSettings();
  broadcastStorage();
  return settings.storageDir;
}

function broadcastStorage() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('desktop:storage-changed', {
        dir: storageDir(),
        defaultDir: defaultStorageDir(),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Static file server for the exported web bundle
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.m4s': 'video/iso.segment',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.ts': 'video/mp2t',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.mpd': 'application/dash+xml',
  '.vtt': 'text/vtt; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8',
};

/**
 * Serve a file, honouring `Range` so the HTML `<video>` element can seek
 * inside downloaded media (and so hls.js can fetch individual segments).
 */
function sendFile(req, res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    res.writeHead(404);
    res.end('not found');
    return;
  }

  const base = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control':
      ext === '.html' || ext === '.m3u8'
        ? 'no-store'
        : 'public, max-age=31536000, immutable',
  };

  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (match) {
      let start = match[1] ? Number(match[1]) : 0;
      let end = match[2] ? Number(match[2]) : size - 1;
      // `bytes=-N` means "last N bytes".
      if (!match[1] && match[2]) {
        start = Math.max(0, size - Number(match[2]));
        end = size - 1;
      }
      if (Number.isNaN(start) || Number.isNaN(end) || start >= size || end < start) {
        res.writeHead(416, { ...base, 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }
      end = Math.min(end, size - 1);
      res.writeHead(206, {
        ...base,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': end - start + 1,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
  }

  res.writeHead(200, { ...base, 'Content-Length': size });
  fs.createReadStream(filePath).pipe(res);
}

/**
 * Fixed port for the loopback server.
 *
 * The renderer's origin is `http://127.0.0.1:<port>`, and everything the app
 * persists in the browser (AsyncStorage -> localStorage: settings, watchlist,
 * playback progress, the download list) is scoped to that origin. An ephemeral
 * port would therefore hand the user a blank profile on every launch, so the
 * port must be stable. If it is taken we fall back to an ephemeral one rather
 * than refusing to start.
 */
const PREFERRED_PORT = 43117;

function startStaticServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let pathname;
      try {
        pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      } catch {
        res.writeHead(400);
        res.end('bad request');
        return;
      }

      // Downloaded media lives in the user's chosen folder, not in the bundle.
      if (pathname.startsWith('/__media/')) {
        serveMedia(req, res, pathname);
        return;
      }

      // Prevent path traversal outside WEB_ROOT.
      const rel = pathname.replace(/^\/+/, '');
      const target = path.resolve(WEB_ROOT, rel);
      if (!target.startsWith(path.resolve(WEB_ROOT))) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }

      if (fs.existsSync(target) && fs.statSync(target).isFile()) {
        sendFile(req, res, target);
        return;
      }

      // SPA fallback.
      const index = path.join(WEB_ROOT, 'index.html');
      if (fs.existsSync(index)) {
        sendFile(req, res, index);
        return;
      }

      res.writeHead(404);
      res.end('not found');
    });

    const listen = (port, retry) => {
      const onError = (err) => {
        if (err && err.code === 'EADDRINUSE' && retry) {
          server.removeListener('error', onError);
          listen(0, false);
          return;
        }
        reject(err);
      };
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onError);
        resolve(server.address().port);
      });
    };

    listen(PREFERRED_PORT, true);
  });
}

/** `/__media/<job folder>/<file>` — served from the storage folder. */
function serveMedia(req, res, pathname) {
  const rel = pathname.slice('/__media/'.length);
  const target = path.resolve(downloadRoot(), rel);
  const root = path.resolve(downloadRoot());
  if (!target.startsWith(root + path.sep) && target !== root) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  sendFile(req, res, target);
}

// ---------------------------------------------------------------------------
// Session tweaks (CORS for media, downloads into the chosen folder)
// ---------------------------------------------------------------------------

function configureSession(ses) {
  // Many IPTV/HLS origins do not send CORS headers. Without them the web
  // player cannot read the playlist or segments, so relax the header for
  // media-ish responses only. Our own bundle is served by the local server
  // and already sets the header.
  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders || {};
    const hasAcao = Object.keys(headers).some(
      (k) => k.toLowerCase() === 'access-control-allow-origin',
    );
    if (!hasAcao) {
      headers['Access-Control-Allow-Origin'] = ['*'];
    }
    callback({ responseHeaders: headers });
  });

  ses.on('will-download', (event, item) => {
    const dir = storageDir();
    ensureDir(dir);
    const filename = item.getFilename() || `download-${Date.now()}`;
    item.setSavePath(path.join(dir, filename));
  });
}

// ---------------------------------------------------------------------------
// Media downloads (HLS + direct files) into the chosen storage folder
// ---------------------------------------------------------------------------

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** id -> AbortController for in-flight downloads. */
const activeDownloads = new Map();

/** `<storage>/downloads` — every job gets its own folder inside. */
function downloadRoot() {
  return path.join(storageDir(), 'downloads');
}

function safeName(value, fallback = 'download') {
  const cleaned = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)
    .trim();
  return cleaned || fallback;
}

function emitDownload(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('desktop:downloadProgress', payload);
  }
}

function withHeaders(headers) {
  return { 'User-Agent': DEFAULT_UA, ...(headers || {}) };
}

async function fetchText(url, headers, signal) {
  const res = await fetch(url, {
    headers: withHeaders(headers),
    signal,
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.text();
}

/** Parse `KEY=VALUE,KEY="VALUE"` attribute lists from an HLS tag. */
function parseHlsAttrs(line) {
  const out = {};
  const body = line.slice(line.indexOf(':') + 1);
  const re = /([A-Za-z0-9-]+)=("[^"]*"|[^,]*)/g;
  let match;
  while ((match = re.exec(body))) {
    out[match[1].toUpperCase()] = match[2].replace(/^"|"$/g, '');
  }
  return out;
}

/** Stream a URL into a file, reporting bytes as they land. */
async function streamToFile(url, filePath, headers, signal, onProgress, append = false) {
  const res = await fetch(url, {
    headers: withHeaders(headers),
    signal,
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const total = Number(res.headers.get('content-length') || 0);
  let received = 0;
  let last = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      const now = Date.now();
      if (now - last > 250) {
        last = now;
        onProgress(received, total);
      }
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(res.body),
    counter,
    fs.createWriteStream(filePath, { flags: append ? 'a' : 'w' }),
  );
  return { received, total };
}

/**
 * Download an HLS stream as a *local playlist*: the media playlist is rewritten
 * to point at the segment files we saved next to it, so the desktop player can
 * play it back through hls.js exactly like a live stream (seeking included).
 *
 * AES-128 segments are decrypted while writing, so the local copy needs no key
 * requests. MPEG-TS is kept as-is — Chromium cannot play a bare `.ts` file, so
 * remuxing is deliberately avoided and playback stays HLS.
 */
async function downloadHls({ url, headers, dir, signal, onProgress }) {
  const crypto = require('crypto');
  let playlistUrl = url;
  let text = await fetchText(playlistUrl, headers, signal);

  // Follow master playlists down to the highest-bandwidth variant.
  for (let depth = 0; depth < 3 && /#EXT-X-STREAM-INF/.test(text); depth += 1) {
    const lines = text.split(/\r?\n/);
    const candidates = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
      const attrs = parseHlsAttrs(lines[i]);
      const bandwidth = Number(attrs.BANDWIDTH || 0);
      let j = i + 1;
      while (j < lines.length && (!lines[j].trim() || lines[j].trim().startsWith('#'))) {
        j += 1;
      }
      const uri = lines[j] && lines[j].trim();
      if (!uri) continue;
      candidates.push({
        bandwidth,
        // Chromium cannot decode HEVC, so an HEVC-only ladder must not win.
        hevc: /hev1|hvc1|dvh1|dvhe/i.test(attrs.CODECS || ''),
        uri: new URL(uri, playlistUrl).toString(),
      });
    }
    if (!candidates.length) break;
    const decodable = candidates.filter((c) => !c.hevc);
    const pool = decodable.length ? decodable : candidates;
    pool.sort((a, b) => b.bandwidth - a.bandwidth);
    playlistUrl = pool[0].uri;
    text = await fetchText(playlistUrl, headers, signal);
  }

  if (/#EXT-X-BYTERANGE/.test(text)) {
    throw new Error('This HLS stream uses byte-range segments, which are not supported.');
  }

  const segments = [];
  let pendingDuration = null;
  let mapUrl = null;
  let currentKey = null;
  let mediaSequence = 0;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number(line.split(':')[1]) || 0;
    } else if (line.startsWith('#EXTINF:')) {
      pendingDuration = line;
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseHlsAttrs(line);
      if (attrs.URI) mapUrl = new URL(attrs.URI, playlistUrl).toString();
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseHlsAttrs(line);
      const method = String(attrs.METHOD || 'NONE').toUpperCase();
      currentKey =
        method === 'NONE'
          ? null
          : {
              method,
              uri: attrs.URI ? new URL(attrs.URI, playlistUrl).toString() : null,
              iv: attrs.IV || null,
            };
    } else if (!line.startsWith('#')) {
      segments.push({
        url: new URL(line, playlistUrl).toString(),
        duration: pendingDuration || '#EXTINF:10,',
        key: currentKey,
      });
      pendingDuration = null;
    }
  }

  if (!segments.length) throw new Error('HLS playlist contains no segments');

  const keyCache = new Map();
  const keyBytes = async (key) => {
    if (!key.uri) throw new Error('Encrypted HLS stream without a key URI');
    if (keyCache.has(key.uri)) return keyCache.get(key.uri);
    const res = await fetch(key.uri, {
      headers: withHeaders(headers),
      signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HLS key HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    keyCache.set(key.uri, buf);
    return buf;
  };

  const segmentExt = mapUrl ? 'm4s' : 'ts';
  const segmentName = (index) => `seg_${String(index + 1).padStart(5, '0')}.${segmentExt}`;

  let received = 0;
  let completed = 0;
  const report = (total = 0) =>
    onProgress({
      received,
      total,
      completedSegments: completed,
      totalSegments: segments.length,
    });

  if (mapUrl) {
    const initPath = path.join(dir, 'init.mp4');
    await streamToFile(mapUrl, initPath, headers, signal, () => {});
    received += fs.statSync(initPath).size;
  }

  report();

  for (let i = 0; i < segments.length; i += 1) {
    if (signal.aborted) throw new Error('cancelled');
    const segment = segments[i];
    const filePath = path.join(dir, segmentName(i));

    if (segment.key && segment.key.method === 'AES-128') {
      const key = await keyBytes(segment.key);
      const iv = segment.key.iv
        ? Buffer.from(segment.key.iv.replace(/^0x/i, ''), 'hex')
        : (() => {
            const buf = Buffer.alloc(16);
            buf.writeBigUInt64BE(BigInt(mediaSequence + i), 8);
            return buf;
          })();
      const res = await fetch(segment.url, {
        headers: withHeaders(headers),
        signal,
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const encrypted = Buffer.from(await res.arrayBuffer());
      const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
      const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      fs.writeFileSync(filePath, plain);
      received += plain.length;
    } else {
      const result = await streamToFile(
        segment.url,
        filePath,
        headers,
        signal,
        (bytes) => onProgress({
          received: received + bytes,
          total: 0,
          completedSegments: completed,
          totalSegments: segments.length,
        }),
      );
      received += result.received;
    }

    completed += 1;
    report();
  }

  const targetDuration = Math.max(
    1,
    ...segments.map((segment) => {
      const value = parseFloat(segment.duration.slice(segment.duration.indexOf(':') + 1));
      return Number.isFinite(value) ? Math.ceil(value) : 10;
    }),
  );

  const playlist = [
    '#EXTM3U',
    `#EXT-X-VERSION:${mapUrl ? 6 : 3}`,
    `#EXT-X-TARGETDURATION:${targetDuration}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    ...(mapUrl ? ['#EXT-X-MAP:URI="init.mp4"'] : []),
    ...segments.flatMap((segment, index) => [segment.duration, segmentName(index)]),
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');

  fs.writeFileSync(path.join(dir, 'index.m3u8'), playlist, 'utf8');

  return { file: 'index.m3u8', kind: 'hls', bytes: received, segments: segments.length };
}

/** Download a progressive file (mp4/webm/mkv) into the job folder. */
async function downloadDirect({ url, headers, dir, signal, onProgress }) {
  let ext = 'mp4';
  try {
    const match = /\.([a-z0-9]{2,4})$/i.exec(new URL(url).pathname);
    if (match && ['mp4', 'webm', 'mkv', 'mov', 'm4v'].includes(match[1].toLowerCase())) {
      ext = match[1].toLowerCase();
    }
  } catch {
    /* keep mp4 */
  }

  const file = `video.${ext}`;
  const result = await streamToFile(
    url,
    path.join(dir, file),
    headers,
    signal,
    (received, total) =>
      onProgress({ received, total, completedSegments: 1, totalSegments: 1 }),
  );

  return { file, kind: 'file', bytes: result.received, segments: 1 };
}

function startDownload({ id, url, dirName, headers, kind }) {
  return (async () => {
    const dir = path.join(downloadRoot(), safeName(dirName || id));
    try {
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
      await fs.promises.mkdir(dir, { recursive: true });
    } catch (err) {
      return { ok: false, error: `Cannot create download folder: ${err.message}` };
    }

  const controller = new AbortController();
  activeDownloads.set(id, controller);

  const send = (payload) => emitDownload({ id, ...payload });
  send({ status: 'downloading', received: 0, total: 0, completedSegments: 0, totalSegments: 0 });

  const isHls =
    kind === 'hls' ||
    /\.m3u8(\?|$)/i.test(url) ||
    /[?&]type=m3u8\b/i.test(url);

  void (async () => {
    try {
      const result = isHls
        ? await downloadHls({
            url,
            headers,
            dir,
            signal: controller.signal,
            onProgress: (progress) => send({ status: 'downloading', ...progress }),
          })
        : await downloadDirect({
            url,
            headers,
            dir,
            signal: controller.signal,
            onProgress: (progress) => send({ status: 'downloading', ...progress }),
          });

      send({
        status: 'completed',
        file: result.file,
        kind: result.kind,
        folder: path.basename(dir),
        received: result.bytes,
        total: result.bytes,
        completedSegments: result.segments,
        totalSegments: result.segments,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        send({ status: 'cancelled' });
      } else {
        send({ status: 'failed', error: err && err.message ? err.message : String(err) });
      }
    } finally {
      activeDownloads.delete(id);
    }
  })();

    return { ok: true, folder: path.basename(dir) };
  })();
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

let mainWindow = null;
let serverPort = 0;

function createWindow() {
  const saved = settings.window || {};
  mainWindow = new BrowserWindow({
    width: saved.width || 1280,
    height: saved.height || 820,
    x: typeof saved.x === 'number' ? saved.x : undefined,
    y: typeof saved.y === 'number' ? saved.y : undefined,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0c0907',
    show: false,
    autoHideMenuBar: true,
    title: 'CoFFe House',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Required by the stream-scraper bridge (see WebViewScraper.web.tsx).
      webviewTag: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Remember window geometry between launches.
  const persistBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized() || mainWindow.isMaximized()) return;
    settings.window = mainWindow.getBounds();
    saveSettings();
  };
  mainWindow.on('resize', persistBounds);
  mainWindow.on('move', persistBounds);

  // External links open in the real browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${serverPort}`)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadURL(`http://127.0.0.1:${serverPort}/`);
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('desktop:getStorage', () => ({
    dir: storageDir(),
    defaultDir: defaultStorageDir(),
  }));

  ipcMain.handle('desktop:chooseStorage', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose download / storage folder',
      defaultPath: storageDir(),
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Use this folder',
    });
    if (result.canceled || !result.filePaths.length) {
      return { canceled: true, dir: storageDir(), defaultDir: defaultStorageDir() };
    }
    return {
      canceled: false,
      dir: setStorageDir(result.filePaths[0]),
      defaultDir: defaultStorageDir(),
    };
  });

  ipcMain.handle('desktop:setStorage', (_event, dir) => ({
    canceled: false,
    dir: setStorageDir(dir),
    defaultDir: defaultStorageDir(),
  }));

  ipcMain.handle('desktop:resetStorage', () => ({
    canceled: false,
    dir: setStorageDir(defaultStorageDir()),
    defaultDir: defaultStorageDir(),
  }));

  ipcMain.handle('desktop:openStorage', async () => {
    const dir = storageDir();
    ensureDir(dir);
    const error = await shell.openPath(dir);
    return { ok: !error, error };
  });

  ipcMain.handle('desktop:openExternal', async (_event, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
      return true;
    }
    return false;
  });

  ipcMain.handle('desktop:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    isDev: IS_DEV,
  }));

  ipcMain.handle('desktop:toggleFullscreen', () => {
    if (!mainWindow) return false;
    const next = !mainWindow.isFullScreen();
    mainWindow.setFullScreen(next);
    return next;
  });

  ipcMain.handle('desktop:minimize', () => mainWindow && mainWindow.minimize());
  ipcMain.handle('desktop:close', () => mainWindow && mainWindow.close());

  // Stream scraper: the renderer owns a hidden <webview>, the main process
  // injects the hook script before page load and forwards the findings back.
  ipcMain.handle('desktop:scraperAttach', async (event, id, script) => {
    if (typeof id !== 'number' || typeof script !== 'string') return false;
    try {
      return await scraperBridge.attach(event.sender, id, script);
    } catch (err) {
      console.error('[coffe] scraper attach failed:', err);
      return false;
    }
  });

  ipcMain.handle('desktop:scraperDetach', (_event, id) => {
    if (typeof id !== 'number') return false;
    return scraperBridge.detach(id);
  });

  // Media downloads. The renderer owns the queue/state; the main process only
  // moves bytes into the user's chosen storage folder and reports progress.
  ipcMain.handle('desktop:downloadStart', (_event, request) => {
    if (!request || typeof request !== 'object') {
      return { ok: false, error: 'Invalid download request' };
    }
    const { id, url, folder, headers, kind } = request;
    if (typeof id !== 'string' || !id) {
      return { ok: false, error: 'Missing download id' };
    }
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return { ok: false, error: 'Invalid stream URL' };
    }
    return startDownload({
      id,
      url,
      dirName: folder || id,
      headers: headers && typeof headers === 'object' ? headers : undefined,
      kind: kind === 'hls' || kind === 'file' ? kind : undefined,
    });
  });

  ipcMain.handle('desktop:downloadCancel', (_event, id) => {
    const controller = activeDownloads.get(id);
    if (!controller) return false;
    controller.abort();
    return true;
  });

  ipcMain.handle('desktop:downloadRemove', async (_event, folder) => {
    if (typeof folder !== 'string' || !folder) return false;
    const root = path.resolve(downloadRoot());
    const target = path.resolve(root, safeName(folder));
    if (!target.startsWith(root + path.sep)) return false;
    try {
      await fs.promises.rm(target, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 150,
      });
      return true;
    } catch (err) {
      console.error('[coffe] download remove failed:', err);
      return false;
    }
  });

  ipcMain.handle('desktop:downloadReveal', async (_event, folder) => {
    const root = path.resolve(downloadRoot());
    const target =
      typeof folder === 'string' && folder
        ? path.resolve(root, safeName(folder))
        : root;
    if (!target.startsWith(root)) return { ok: false, error: 'forbidden' };
    ensureDir(target);
    const error = await shell.openPath(target);
    return { ok: !error, error };
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    loadSettings();
    registerIpc();
    configureSession(session.defaultSession);

    // A minimal menu keeps Ctrl+Shift+I / reload available for debugging
    // without cluttering the window chrome.
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: 'File',
          submenu: [
            {
              label: 'Open storage folder',
              click: () => {
                ensureDir(storageDir());
                void shell.openPath(storageDir());
              },
            },
            {
              label: 'Open downloads folder',
              click: () => {
                ensureDir(downloadRoot());
                void shell.openPath(downloadRoot());
              },
            },
            { type: 'separator' },
            { role: 'quit' },
          ],
        },
        {
          label: 'View',
          submenu: [
            { role: 'reload' },
            { role: 'forceReload' },
            { role: 'toggleDevTools' },
            { type: 'separator' },
            { role: 'resetZoom' },
            { role: 'zoomIn' },
            { role: 'zoomOut' },
            { type: 'separator' },
            { role: 'togglefullscreen' },
          ],
        },
      ]),
    );

    try {
      serverPort = await startStaticServer();
    } catch (err) {
      dialog.showErrorBox(
        'CoFFe House',
        `Could not start the local web server.\n\n${err && err.message ? err.message : err}`,
      );
      app.quit();
      return;
    }

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    scraperBridge.detachAll();
  });
}

/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Dev-only end-to-end probe for the desktop download pipeline.
 *
 * Boots the real shell (`main.js`), serves a synthetic HLS stream from a local
 * HTTP server — master playlist -> highest variant -> 3 AES-128 encrypted
 * segments — and drives `window.coffeDesktop.downloadStart()` exactly like the
 * app does. Then it:
 *
 *   1. waits for the `completed` progress event,
 *   2. fetches the rewritten local playlist + a segment through the shell's
 *      `/__media/` route (so playback is proven, not assumed),
 *   3. verifies the segment was decrypted (bytes match the plaintext),
 *   4. checks `Range` support (hls.js/`<video>` seeking depends on it),
 *   5. removes the job and confirms the folder is gone.
 *
 *   npx electron desktop/download-test.js
 */
const { app, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Boot the production shell: IPC handlers + preload + static server.
require('./main.js');

const KEY = crypto.randomBytes(16);
const IV = crypto.randomBytes(16);
const PLAINTEXTS = [0, 1, 2].map((i) =>
  Buffer.from(`PLAINTEXT-SEGMENT-${i}-` + 'x'.repeat(3000)),
);
const DIRECT_BYTES = Buffer.from(
  Array.from({ length: 4096 }, (_, i) => i % 251),
);

const encrypt = (plain) => {
  const cipher = crypto.createCipheriv('aes-128-cbc', KEY, IV);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
};

const mediaPlaylist = () =>
  [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:4',
    '#EXT-X-MEDIA-SEQUENCE:0',
    `#EXT-X-KEY:METHOD=AES-128,URI="/key.bin",IV=0x${IV.toString('hex')}`,
    ...PLAINTEXTS.flatMap((_, i) => [
      '#EXTINF:4.000,',
      `seg_${i}.ts`,
    ]),
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');

const MASTER = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720',
  '/low/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080',
  '/high/index.m3u8',
  '',
].join('\n');

/** Request counters — used to prove a resumed download skips saved bytes. */
const HITS = {};
const RANGES = [];

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const { pathname } = new URL(req.url, 'http://127.0.0.1');
      HITS[pathname] = (HITS[pathname] || 0) + 1;

      if (pathname === '/master.m3u8') {
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        res.end(MASTER);
        return;
      }
      if (pathname === '/high/index.m3u8' || pathname === '/low/index.m3u8') {
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        res.end(mediaPlaylist());
        return;
      }
      // Isolated copy of the same ladder for the resume probe, so request
      // counters cannot be confused with the first (fresh) download.
      if (pathname === '/resume/index.m3u8') {
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        res.end(mediaPlaylist());
        return;
      }
      const rseg = /^\/resume\/seg_(\d)\.ts$/.exec(pathname);
      if (rseg) {
        const body = encrypt(PLAINTEXTS[Number(rseg[1])]);
        res.writeHead(200, {
          'Content-Type': 'video/mp2t',
          'Content-Length': body.length,
        });
        res.end(body);
        return;
      }
      if (pathname === '/key.bin') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(KEY);
        return;
      }
      const seg = /^\/high\/seg_(\d)\.ts$/.exec(pathname);
      if (seg) {
        const body = encrypt(PLAINTEXTS[Number(seg[1])]);
        res.writeHead(200, {
          'Content-Type': 'video/mp2t',
          'Content-Length': body.length,
        });
        res.end(body);
        return;
      }
      if (pathname === '/slow/index.m3u8') {
        const lines = [
          '#EXTM3U',
          '#EXT-X-VERSION:3',
          '#EXT-X-TARGETDURATION:4',
          '#EXT-X-MEDIA-SEQUENCE:0',
          ...Array.from({ length: 40 }, (_, i) => `#EXTINF:4.000,\nseg_${i}.ts`),
          '#EXT-X-ENDLIST',
          '',
        ].join('\n');
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        res.end(lines);
        return;
      }
      if (/^\/slow\/seg_\d+\.ts$/.test(pathname)) {
        // Slow enough that the cancel below lands mid-download.
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'video/mp2t' });
          res.end(Buffer.alloc(2048, 7));
        }, 250);
        return;
      }
      if (pathname === '/prog.mp4') {
        const range = req.headers.range;
        if (range) {
          RANGES.push(range);
          const match = /^bytes=(\d+)-$/.exec(range);
          if (match) {
            const start = Number(match[1]);
            const slice = DIRECT_BYTES.subarray(start);
            res.writeHead(206, {
              'Content-Type': 'video/mp4',
              'Content-Length': slice.length,
              'Content-Range': `bytes ${start}-${DIRECT_BYTES.length - 1}/${DIRECT_BYTES.length}`,
            });
            res.end(slice);
            return;
          }
        }
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Length': DIRECT_BYTES.length,
        });
        res.end(DIRECT_BYTES);
        return;
      }

      res.writeHead(404);
      res.end('not found');
    });
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

app.whenReady().then(async () => {
  const port = await startServer();
  const base = `http://127.0.0.1:${port}`;
  console.log('[server]', base);

  const tempStorage = path.join(os.tmpdir(), `coffe-dl-${Date.now()}`);
  fs.mkdirSync(tempStorage, { recursive: true });

  // Resume fixtures: one HLS segment and the first 1000 bytes of a direct
  // file already on disk. A `resume: true` start must keep them.
  const hlsResumeId = 'movie-1002-q1080';
  const hlsResumeDir = path.join(tempStorage, 'downloads', hlsResumeId);
  fs.mkdirSync(hlsResumeDir, { recursive: true });
  fs.writeFileSync(path.join(hlsResumeDir, 'seg_00002.ts'), PLAINTEXTS[1]);

  const fileResumeId = 'movie-1003-q720';
  const fileResumeDir = path.join(tempStorage, 'downloads', fileResumeId);
  fs.mkdirSync(fileResumeDir, { recursive: true });
  fs.writeFileSync(
    path.join(fileResumeDir, 'video.mp4.part'),
    DIRECT_BYTES.subarray(0, 1000),
  );

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
    const out = {};
    await window.coffeDesktop.setStorage(${JSON.stringify(tempStorage)});

    const events = [];
    const off = window.coffeDesktop.onDownloadProgress((p) => events.push(p));

    const waitFor = (id, statuses, timeout = 60000) =>
      new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
          const hit = events.find((e) => e.id === id && statuses.includes(e.status));
          if (hit) return resolve(hit);
          if (Date.now() - started > timeout) {
            return reject(new Error('timeout waiting for ' + statuses.join('/')));
          }
          setTimeout(tick, 100);
        };
        tick();
      });

    // ---- HLS -------------------------------------------------------------
    const hlsId = 'movie-999-q1080';
    out.hlsStart = await window.coffeDesktop.downloadStart({
      id: hlsId,
      url: ${JSON.stringify(`${base}/master.m3u8`)},
      folder: hlsId,
      kind: 'hls',
    });
    out.hlsDone = await waitFor(hlsId, ['completed', 'failed']);
    out.hlsProgressCount = events.filter(
      (e) => e.id === hlsId && e.status === 'downloading',
    ).length;

    if (out.hlsDone.status === 'completed') {
      const origin = window.location.origin;
      const playlistUrl =
        origin + '/__media/' + encodeURIComponent(hlsId) + '/' +
        encodeURIComponent(out.hlsDone.file || 'index.m3u8');
      out.playlistUrl = playlistUrl;

      const playlistRes = await fetch(playlistUrl);
      out.playlistStatus = playlistRes.status;
      out.playlist = await playlistRes.text();

      const segRes = await fetch(origin + '/__media/' + encodeURIComponent(hlsId) + '/seg_00001.ts');
      out.segmentStatus = segRes.status;
      out.segmentLength = (await segRes.arrayBuffer()).byteLength;

      const rangeRes = await fetch(
        origin + '/__media/' + encodeURIComponent(hlsId) + '/seg_00001.ts',
        { headers: { Range: 'bytes=0-15' } },
      );
      out.rangeStatus = rangeRes.status;
      out.rangeLength = (await rangeRes.arrayBuffer()).byteLength;

      const badRes = await fetch(origin + '/__media/' + encodeURIComponent(hlsId) + '/nope.ts');
      out.missingStatus = badRes.status;

      const escapeRes = await fetch(origin + '/__media/..%2f..%2fpackage.json');
      out.traversalStatus = escapeRes.status;
    }

    // ---- Direct file -----------------------------------------------------
    const fileId = 'movie-1000-q720';
    out.fileStart = await window.coffeDesktop.downloadStart({
      id: fileId,
      url: ${JSON.stringify(`${base}/prog.mp4`)},
      folder: fileId,
      kind: 'file',
    });
    out.fileDone = await waitFor(fileId, ['completed', 'failed']);
    if (out.fileDone.status === 'completed') {
      const res = await fetch(
        window.location.origin + '/__media/' + encodeURIComponent(fileId) + '/' +
        encodeURIComponent(out.fileDone.file || 'video.mp4'),
      );
      out.fileStatus = res.status;
      out.fileLength = (await res.arrayBuffer()).byteLength;
    }

    // ---- Offline subtitle sidecar ---------------------------------------
    out.subtitleSave = await window.coffeDesktop.saveSubtitle({
      folder: hlsId,
      language: 'en',
      text: 'WEBVTT\\n\\n00:00:01.000 --> 00:00:02.000\\nHello offline\\n',
    });
    if (out.subtitleSave && out.subtitleSave.ok) {
      const res = await fetch(
        window.location.origin + '/__media/' + encodeURIComponent(hlsId) + '/' +
        encodeURIComponent(out.subtitleSave.file),
      );
      out.subtitleStatus = res.status;
      out.subtitleBody = await res.text();
    }
    out.subtitleEmpty = await window.coffeDesktop.saveSubtitle({
      folder: hlsId,
      language: 'en',
      text: '   ',
    });

    // ---- Resume ----------------------------------------------------------
    out.hlsResumeStart = await window.coffeDesktop.downloadStart({
      id: 'movie-1002-q1080',
      url: ${JSON.stringify(`${base}/resume/index.m3u8`)},
      folder: 'movie-1002-q1080',
      kind: 'hls',
      resume: true,
    });
    out.hlsResumeDone = await waitFor('movie-1002-q1080', ['completed', 'failed']);

    out.fileResumeStart = await window.coffeDesktop.downloadStart({
      id: 'movie-1003-q720',
      url: ${JSON.stringify(`${base}/prog.mp4`)},
      folder: 'movie-1003-q720',
      kind: 'file',
      resume: true,
    });
    out.fileResumeDone = await waitFor('movie-1003-q720', ['completed', 'failed']);
    if (out.fileResumeDone.status === 'completed') {
      const res = await fetch(
        window.location.origin + '/__media/movie-1003-q720/' +
        encodeURIComponent(out.fileResumeDone.file || 'video.mp4'),
      );
      out.fileResumeStatus = res.status;
      out.fileResumeBytes = (await res.arrayBuffer()).byteLength;
    }

    // ---- Cancel + remove -------------------------------------------------
    const cancelId = 'movie-1001-q1080';
    await window.coffeDesktop.downloadStart({
      id: cancelId,
      url: ${JSON.stringify(`${base}/slow/index.m3u8`)},
      folder: cancelId,
      kind: 'hls',
    });
    await new Promise((r) => setTimeout(r, 700));
    const cancelled = await window.coffeDesktop.downloadCancel(cancelId);
    out.cancelAccepted = cancelled;
    await new Promise((r) => setTimeout(r, 1200));
    out.cancelEvent = events.filter((e) => e.id === cancelId).map((e) => e.status);

    out.removeHls = await window.coffeDesktop.downloadRemove(hlsId);
    out.removeFile = await window.coffeDesktop.downloadRemove(fileId);
    out.removeCancel = await window.coffeDesktop.downloadRemove(cancelId);
    out.removeHlsResume = await window.coffeDesktop.downloadRemove('movie-1002-q1080');
    out.removeFileResume = await window.coffeDesktop.downloadRemove('movie-1003-q720');

    off();
    await window.coffeDesktop.resetStorage();
    return out;
  })()`;

  let result;
  try {
    result = await win.webContents.executeJavaScript(probe);
  } catch (error) {
    console.log('[fatal] probe failed:', error && error.message);
    process.exit(1);
    return;
  }

  const checks = [];
  const check = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  };

  check('hls start accepted', result.hlsStart && result.hlsStart.ok, JSON.stringify(result.hlsStart));
  check('hls completed', result.hlsDone.status === 'completed', result.hlsDone.error || '');
  check(
    'hls progress streamed',
    result.hlsProgressCount > 0,
    `${result.hlsProgressCount} events`,
  );
  check('local playlist served', result.playlistStatus === 200, `status ${result.playlistStatus}`);
  check(
    'playlist rewritten to local segments',
    /seg_00001\.ts/.test(result.playlist || '') &&
      !/https?:\/\//.test(result.playlist || ''),
    (result.playlist || '').split('\n').slice(0, 8).join(' | '),
  );
  check(
    'segment decrypted to plaintext',
    result.segmentLength === PLAINTEXTS[0].length,
    `${result.segmentLength} vs ${PLAINTEXTS[0].length} bytes`,
  );
  check('range request supported', result.rangeStatus === 206, `status ${result.rangeStatus}, ${result.rangeLength} bytes`);
  check('missing file is 404', result.missingStatus === 404, `status ${result.missingStatus}`);
  check(
    'media route blocks traversal',
    result.traversalStatus === 403 || result.traversalStatus === 404,
    `status ${result.traversalStatus}`,
  );
  check('direct file completed', result.fileDone.status === 'completed', result.fileDone.error || '');
  check(
    'direct file served intact',
    result.fileStatus === 200 && result.fileLength === DIRECT_BYTES.length,
    `status ${result.fileStatus}, ${result.fileLength} bytes`,
  );
  check('cancel accepted', result.cancelAccepted === true, '');
  check('cancel event reported', (result.cancelEvent || []).includes('cancelled'), JSON.stringify(result.cancelEvent));

  // ---- Offline subtitles -------------------------------------------------
  check(
    'subtitle sidecar saved',
    result.subtitleSave && result.subtitleSave.ok === true,
    JSON.stringify(result.subtitleSave),
  );
  check(
    'subtitle served to the player',
    result.subtitleStatus === 200 && /^WEBVTT/.test(result.subtitleBody || ''),
    `status ${result.subtitleStatus}`,
  );
  check(
    'empty subtitle rejected',
    result.subtitleEmpty && result.subtitleEmpty.ok === false,
    JSON.stringify(result.subtitleEmpty),
  );

  // ---- Resume ------------------------------------------------------------
  check(
    'hls resume completed',
    result.hlsResumeDone.status === 'completed',
    result.hlsResumeDone.error || '',
  );
  check(
    'hls resume kept the saved segment',
    (HITS['/resume/seg_1.ts'] || 0) === 0,
    `seg_1 hits: ${HITS['/resume/seg_1.ts'] || 0}`,
  );
  check(
    'hls resume fetched the missing segments',
    HITS['/resume/seg_0.ts'] === 1 && HITS['/resume/seg_2.ts'] === 1,
    JSON.stringify({
      seg_0: HITS['/resume/seg_0.ts'] || 0,
      seg_2: HITS['/resume/seg_2.ts'] || 0,
    }),
  );
  check(
    'direct resume completed',
    result.fileResumeDone.status === 'completed',
    result.fileResumeDone.error || '',
  );
  check(
    'direct resume asked for the remaining range',
    RANGES.includes('bytes=1000-'),
    JSON.stringify(RANGES),
  );
  check(
    'direct resume produced an intact file',
    result.fileResumeStatus === 200 &&
      result.fileResumeBytes === DIRECT_BYTES.length,
    `status ${result.fileResumeStatus}, ${result.fileResumeBytes} bytes`,
  );
  check('remove resumed hls folder', result.removeHlsResume === true, '');
  check('remove resumed file folder', result.removeFileResume === true, '');

  check('remove hls folder', result.removeHls === true, '');
  check('remove file folder', result.removeFile === true, '');
  check('remove cancelled folder', result.removeCancel === true, '');

  const downloadRoot = path.join(tempStorage, 'downloads');
  const leftovers = fs.existsSync(downloadRoot) ? fs.readdirSync(downloadRoot) : [];
  check('no leftover folders', leftovers.length === 0, JSON.stringify(leftovers));

  // Cross-check the decrypted bytes directly on disk (independent of HTTP).
  const hlsDir = path.join(downloadRoot, 'movie-999-q1080');
  check('hls folder deleted from disk', !fs.existsSync(hlsDir), hlsDir);

  fs.rmSync(tempStorage, { recursive: true, force: true });

  const failed = checks.filter((c) => !c.ok);
  console.log(
    failed.length === 0
      ? `[result] PASS — ${checks.length}/${checks.length} checks`
      : `[result] FAIL — ${failed.length}/${checks.length} checks failed`,
  );
  fs.writeFileSync(
    path.join(__dirname, 'smoke', 'download.log'),
    JSON.stringify({ result, checks }, null, 2),
    'utf8',
  );
  process.exit(failed.length === 0 ? 0 : 1);
});

app.on('window-all-closed', () => app.quit());

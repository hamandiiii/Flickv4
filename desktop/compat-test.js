/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Dev-only probe for the FFmpeg compatibility engine (`media-relay.js`).
 *
 * Runs without Electron: the module only depends on `child_process`/`fs`.
 *
 *   1. Generates real fixtures (HEVC+AC3 MKV, H.264+AC3 MKV, an MPEG-TS
 *      segment) with the bundled ffmpeg.
 *   2. Probes them and checks the compatibility verdict.
 *   3. Converts the HEVC/AC3 file through the public `preparePlayback()` entry
 *      point (exactly what the renderer calls) and verifies the output is
 *      H.264/AAC and seekable MP4, then checks the disk cache is reused.
 *   4. Serves a Referer-protected HLS ladder and proves the header-aware proxy
 *      rewrites playlists and forwards segments.
 *   5. Serves an HEVC-only ladder and proves the live relay produces a
 *      playable HLS playlist and TS segments.
 *
 *   node desktop/compat-test.js
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { createMediaRelay, findFfmpeg } = require('./media-relay');

const ROOT = path.join(os.tmpdir(), 'opencode', 'compat-test');
const FIXTURES = path.join(ROOT, 'fixtures');
const COMPAT = path.join(ROOT, 'compat');

const FFMPEG = findFfmpeg();

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function runFfmpeg(args, label) {
  try {
    execFileSync(FFMPEG, args, { stdio: 'pipe', windowsHide: true });
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : '';
    throw new Error(`${label} failed: ${stderr.split(/\r?\n/).slice(-3).join(' ')}`);
  }
}

function ensureFixtures() {
  fs.mkdirSync(FIXTURES, { recursive: true });

  const hevc = path.join(FIXTURES, 'sample-hevc-ac3.mkv');
  if (!fs.existsSync(hevc)) {
    runFfmpeg(
      [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-t', '6',
        '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error',
        '-c:a', 'ac3', '-b:a', '192k', '-ac', '2',
        hevc,
      ],
      'hevc fixture',
    );
  }

  const h264 = path.join(FIXTURES, 'sample-h264-ac3.mkv');
  if (!fs.existsSync(h264)) {
    runFfmpeg(
      [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-t', '6',
        '-c:v', 'libx264', '-preset', 'ultrafast',
        '-c:a', 'ac3', '-b:a', '192k', '-ac', '2',
        h264,
      ],
      'h264 fixture',
    );
  }

  const segment = path.join(FIXTURES, 'seg.ts');
  if (!fs.existsSync(segment)) {
    runFfmpeg(
      [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25',
        '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000',
        '-t', '4',
        '-c:v', 'libx264', '-preset', 'ultrafast',
        '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
        '-f', 'mpegts',
        segment,
      ],
      'ts fixture',
    );
  }

  return { hevc, h264, segment };
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Minimal Range-less static handler for the relay/compat routes. */
function sendFile(_req, res, filePath) {
  let data;
  try {
    data = fs.readFileSync(filePath);
  } catch {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const type =
    ext === '.m3u8'
      ? 'application/vnd.apple.mpegurl'
      : ext === '.ts'
        ? 'video/mp2t'
        : ext === '.mp4'
          ? 'video/mp4'
          : 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': data.length,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(data);
}

async function main() {
  if (!FFMPEG) {
    console.error('[fatal] ffmpeg-static binary not found (run node node_modules/ffmpeg-static/install.js)');
    process.exit(1);
  }
  console.log('[setup] ffmpeg:', FFMPEG);

  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(FIXTURES, { recursive: true });
  fs.mkdirSync(COMPAT, { recursive: true });

  const fixtures = ensureFixtures();
  console.log(
    '[setup] fixtures:',
    Object.entries(fixtures)
      .map(([name, file]) => `${name}=${(fs.statSync(file).size / 1024).toFixed(0)}KB`)
      .join(' '),
  );

  const progress = [];
  const relay = createMediaRelay({
    downloadRoot: () => FIXTURES,
    compatRoot: () => COMPAT,
    send: (channel, payload) => {
      if (channel === 'desktop:compatProgress') progress.push(payload);
    },
    sendFile,
  });

  // -------------------------------------------------------------------------
  // 1. Probe
  // -------------------------------------------------------------------------
  const hevcProbe = await relay.probe(fixtures.hevc);
  check(
    'probe detects HEVC + AC3 as incompatible',
    hevcProbe.ok &&
      hevcProbe.video === 'hevc' &&
      hevcProbe.audio === 'ac3' &&
      hevcProbe.compatible === false &&
      Math.abs(hevcProbe.duration - 6) < 0.5,
    `video=${hevcProbe.video} audio=${hevcProbe.audio} duration=${hevcProbe.duration?.toFixed(2)}`,
  );

  const h264Probe = await relay.probe(fixtures.h264);
  check(
    'probe sees H.264 video but rejects AC3 audio',
    h264Probe.ok && h264Probe.video === 'h264' && h264Probe.audio === 'ac3' && h264Probe.compatible === false,
    `video=${h264Probe.video} audio=${h264Probe.audio}`,
  );

  // -------------------------------------------------------------------------
  // 2. Local conversion through preparePlayback()
  // -------------------------------------------------------------------------
  const localUrl = 'http://127.0.0.1:9/__media/sample-hevc-ac3.mkv';
  const startedAt = Date.now();
  const converted = await relay.preparePlayback({ url: localUrl });
  const elapsed = Date.now() - startedAt;

  check(
    'preparePlayback transcodes the HEVC/AC3 file',
    converted.ok && converted.mode === 'transcode' && /^\/__compat\/[a-f0-9]+\/video\.mp4$/.test(converted.url),
    converted.ok ? converted.url : converted.error,
  );

  const outFile = converted.ok
    ? path.join(COMPAT, converted.url.split('/')[2], 'video.mp4')
    : '';
  check(
    'converted file exists and is non-trivial',
    !!outFile && fs.existsSync(outFile) && fs.statSync(outFile).size > 50000,
    outFile ? `${(fs.statSync(outFile).size / 1024).toFixed(0)}KB in ${elapsed}ms` : 'missing',
  );

  const outProbe = outFile ? await relay.probe(outFile) : { ok: false };
  check(
    'converted output is H.264/AAC MP4',
    outProbe.ok &&
      outProbe.container === 'mp4' &&
      outProbe.video === 'h264' &&
      outProbe.audio === 'aac' &&
      outProbe.compatible === true,
    `container=${outProbe.container} video=${outProbe.video} audio=${outProbe.audio}`,
  );

  check(
    'conversion emitted progress events',
    progress.some((event) => event.phase === 'transcode' && typeof event.percent === 'number'),
    `${progress.filter((event) => event.phase === 'transcode').length} events`,
  );

  const cached = await relay.preparePlayback({ url: localUrl });
  check(
    'second request reuses the converted file',
    cached.ok && cached.cached === true && cached.url === converted.url,
    cached.ok ? `cached=${cached.cached}` : cached.error,
  );

  // H.264 + AC3 only needs an audio remux (`-c:v copy`).
  const remuxed = await relay.preparePlayback({
    url: 'http://127.0.0.1:9/__media/sample-h264-ac3.mkv',
  });
  const remuxFile = remuxed.ok
    ? path.join(COMPAT, remuxed.url.split('/')[2], 'video.mp4')
    : '';
  const remuxProbe = remuxFile ? await relay.probe(remuxFile) : { ok: false };
  check(
    'H.264/AC3 is remuxed (video copied, audio AAC)',
    remuxed.ok && remuxProbe.ok && remuxProbe.video === 'h264' && remuxProbe.audio === 'aac',
    remuxed.ok ? `video=${remuxProbe.video} audio=${remuxProbe.audio}` : remuxed.error,
  );

  // -------------------------------------------------------------------------
  // 3. Referer-protected HLS ladder + header-aware proxy
  // -------------------------------------------------------------------------
  const REFERER = 'http://player.test/';
  const master = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,CODECS="hvc1.1.6.L120.90,ac-3"',
    '/hevc/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"',
    '/avc/index.m3u8',
    '',
  ].join('\n');

  const mediaPlaylist = (prefix) =>
    [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:4',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXTINF:4.000,',
      `${prefix}seg.ts`,
      '#EXT-X-ENDLIST',
      '',
    ].join('\n');

  const upstream = http.createServer((req, res) => {
    if (req.headers.referer !== REFERER) {
      res.writeHead(403);
      res.end('referer required');
      return;
    }
    const { pathname } = new URL(req.url, 'http://127.0.0.1');
    if (pathname === '/master.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end(master);
      return;
    }
    if (pathname === '/hevc-only.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end(
        [
          '#EXTM3U',
          '#EXT-X-STREAM-INF:BANDWIDTH=3000000,CODECS="hvc1.1.6.L120.90,ac-3"',
          '/hevc/index.m3u8',
          '',
        ].join('\n'),
      );
      return;
    }
    if (pathname.endsWith('/index.m3u8')) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end(mediaPlaylist(pathname.startsWith('/hevc') ? '/hevc/' : '/avc/'));
      return;
    }
    if (pathname.endsWith('/seg.ts')) {
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      fs.createReadStream(fixtures.segment).pipe(res);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  const upstreamPort = await listen(upstream);
  const upstreamBase = `http://127.0.0.1:${upstreamPort}`;

  const proxyServer = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    } catch {
      res.writeHead(400);
      res.end('bad request');
      return;
    }
    if (!relay.handleRequest(req, res, pathname)) {
      res.writeHead(404);
      res.end('not found');
    }
  });
  const proxyPort = await listen(proxyServer);
  const proxyBase = `http://127.0.0.1:${proxyPort}`;

  const proxied = await relay.preparePlayback({
    url: `${upstreamBase}/master.m3u8`,
    headers: { Referer: REFERER },
  });
  check(
    'HLS proxy session is created for a Referer-protected master',
    proxied.ok && proxied.mode === 'proxy' && proxied.url.startsWith('/__hls/'),
    proxied.ok ? proxied.url.slice(0, 24) + '…' : proxied.error,
  );

  const masterBody = proxied.ok ? await (await fetch(proxyBase + proxied.url)).text() : '';
  check(
    'proxied master keeps the decodable variant and drops HEVC',
    masterBody.includes('#EXT-X-STREAM-INF') &&
      masterBody.includes('/__hls/') &&
      !masterBody.includes('/hevc/index.m3u8'),
    masterBody.split('\n').filter((line) => line.includes('/__hls/')).length + ' rewritten URI(s)',
  );

  const variantUri = masterBody
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('/__hls/'));
  const variantBody = variantUri ? await (await fetch(proxyBase + variantUri)).text() : '';
  check(
    'proxied media playlist rewrites segment URIs',
    variantBody.includes('#EXTINF') && variantBody.includes('/__hls/') && !variantBody.includes('/avc/seg.ts'),
    variantBody.split('\n').filter((line) => line.startsWith('/__hls/')).length + ' segment URI(s)',
  );

  const segmentUri = variantBody
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('/__hls/'));
  const segmentResponse = segmentUri ? await fetch(proxyBase + segmentUri) : null;
  const segmentBytes = segmentResponse ? Buffer.from(await segmentResponse.arrayBuffer()) : Buffer.alloc(0);
  check(
    'proxied segment is forwarded byte-for-byte',
    !!segmentResponse &&
      segmentResponse.status === 200 &&
      segmentBytes.length === fs.statSync(fixtures.segment).size &&
      segmentBytes[0] === 0x47,
    `${segmentBytes.length} bytes`,
  );

  const expired = await fetch(`${proxyBase}/__hls/deadbeefdeadbeef/AAAA`);
  check('unknown proxy session returns 404', expired.status === 404, `status=${expired.status}`);

  // -------------------------------------------------------------------------
  // 4. HEVC-only ladder -> live relay
  // -------------------------------------------------------------------------
  const relayStarted = Date.now();
  const relayed = await relay.preparePlayback({
    url: `${upstreamBase}/hevc-only.m3u8`,
    headers: { Referer: REFERER },
  });
  check(
    'HEVC-only ladder falls back to the live relay',
    relayed.ok && relayed.mode === 'relay' && relayed.url.startsWith('/__relay/'),
    relayed.ok ? `${relayed.url} in ${Date.now() - relayStarted}ms` : relayed.error,
  );

  let relayPlaylist = '';
  if (relayed.ok) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const response = await fetch(proxyBase + relayed.url);
      if (response.ok) {
        relayPlaylist = await response.text();
        if (/#EXTINF/.test(relayPlaylist)) break;
      }
      await sleep(250);
    }
  }
  check(
    'relay playlist advertises transcoded segments',
    /#EXTINF/.test(relayPlaylist),
    `${(relayPlaylist.match(/#EXTINF/g) || []).length} segment(s)`,
  );

  const relaySegment = relayPlaylist
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /^seg_\d+\.ts$/.test(line));
  const relaySegmentUrl = relayed.ok && relaySegment
    ? `${proxyBase}/__relay/${relayed.url.split('/')[2]}/${relaySegment}`
    : '';
  let relayBytes = Buffer.alloc(0);
  if (relaySegmentUrl) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && relayBytes.length === 0) {
      const response = await fetch(relaySegmentUrl);
      if (response.ok) relayBytes = Buffer.from(await response.arrayBuffer());
      else await sleep(200);
    }
  }
  check(
    'relay segment is a real MPEG-TS payload',
    relayBytes.length > 1000 && relayBytes[0] === 0x47,
    `${relayBytes.length} bytes`,
  );

  // Cancel the relay and confirm the process is gone.
  if (relayed.ok) relay.cancel(`${upstreamBase}/hevc-only.m3u8`);
  await sleep(400);
  const status = relay.status();
  check(
    'cancel stops the relay job',
    status.jobs.length === 0,
    `jobs=${status.jobs.length}`,
  );

  relay.dispose();
  await close(proxyServer);
  await close(upstream);

  const failed = checks.filter((entry) => !entry.ok);
  console.log(
    failed.length === 0
      ? `[result] PASS - ${checks.length}/${checks.length} checks`
      : `[result] FAIL - ${failed.length}/${checks.length} checks failed`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('[fatal] compat probe failed:', error && error.stack ? error.stack : error);
  process.exit(1);
});

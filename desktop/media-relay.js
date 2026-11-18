/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * CoFFe House — FFmpeg compatibility engine.
 *
 * Chromium (and therefore the `<video>` element the desktop player uses) cannot
 * demux Matroska or decode HEVC/H.265, and it has no AC3/E-AC3/DTS audio
 * decoder. Many IPTV/HLS origins also refuse requests that lack a `Referer` or
 * a session cookie. This module makes those sources playable *inside* the app:
 *
 *   1. `probe()`      — ask ffmpeg what is inside a file/URL.
 *   2. local files    — remux (H.264 + bad audio) or transcode (HEVC) into
 *                       `<storage>/compat/<key>/video.mp4`, then serve it with
 *                       HTTP Range support so seeking is native.
 *   3. HLS playlists  — proxy the playlist/segments through the shell's
 *                       loopback server with the app's headers and a cookie
 *                       jar. HEVC-only ladders are dropped in favour of a
 *                       decodable variant when one exists.
 *   4. last resort    — a live ffmpeg HLS relay (`/__relay/<key>/index.m3u8`)
 *                       that transcodes the source to H.264/AAC on the fly.
 *
 * Nothing here touches the mobile source: it is only loaded by `main.js`.
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** Containers Chromium can demux natively. */
const CONTAINER_OK = new Set(['mp4', 'm4v', 'mov', 'webm']);
/** Video codecs Chromium decodes (HEVC is deliberately excluded). */
const VIDEO_OK = new Set(['h264', 'vp8', 'vp9', 'av1']);
/** Audio codecs Chromium decodes. */
const AUDIO_OK = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);

const PROBE_TIMEOUT_MS = 25000;
const PROXY_TIMEOUT_MS = 60000;
const RELAY_READY_TIMEOUT_MS = 45000;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const sha1 = (value) => crypto.createHash('sha1').update(String(value)).digest('hex');

/** Readable byte size for log lines / progress payloads. */
function mb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `video.mkv?token=1` -> `mkv`. */
function extensionOf(value) {
  try {
    const parsed = /^[a-z]+:\/\//i.test(value) ? new URL(value) : null;
    const pathname = parsed ? parsed.pathname : value;
    const match = /\.([a-z0-9]{2,5})$/i.exec(pathname);
    return match ? match[1].toLowerCase() : '';
  } catch {
    const match = /\.([a-z0-9]{2,5})$/i.exec(value);
    return match ? match[1].toLowerCase() : '';
  }
}

/** Normalise an arbitrary header bag to `{ Key: 'value' }` with strings only. */
function normalizeHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== 'string' || !value) continue;
    if (/[\r\n]/.test(key) || /[\r\n]/.test(value)) continue;
    out[key] = value;
  }
  return out;
}

/** ffmpeg's `-headers` wants CRLF-terminated lines. */
function ffmpegHeaderBlock(headers) {
  const entries = Object.entries(headers || {});
  if (!entries.length) return '';
  return entries.map(([key, value]) => `${key}: ${value}\r\n`).join('');
}

function hasHeader(headers, name) {
  return Object.keys(headers || {}).some((key) => key.toLowerCase() === name);
}

/** Kill a child process without throwing on an already-dead pid. */
function killChild(child) {
  if (!child || child.exitCode != null) return;
  try {
    child.kill();
  } catch {
    /* already gone */
  }
}

function parseAttrs(line) {
  const out = {};
  const body = line.slice(line.indexOf(':') + 1);
  const re = /([A-Za-z0-9-]+)=("[^"]*"|[^,]*)/g;
  let match;
  while ((match = re.exec(body))) {
    out[match[1].toUpperCase()] = match[2].replace(/^"|"$/g, '');
  }
  return out;
}

const isHevcCodec = (codecs) => /hev1|hvc1|dvh1|dvhe/i.test(codecs || '');

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {() => string} options.downloadRoot   `<storage>/downloads`
 * @param {() => string} options.compatRoot     `<storage>/compat`
 * @param {(channel: string, payload: unknown) => void} options.send
 * @param {(req, res, filePath, opts?) => void} options.sendFile
 * @param {(...args: unknown[]) => void} [options.log]
 */
/** Locate the bundled ffmpeg binary (packaged `resources/ffmpeg` or dev node_modules). */
function resolveFfmpegPath() {
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe'));
    candidates.push(path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg'));
  }
  candidates.push(path.join(__dirname, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'));
  candidates.push(path.join(__dirname, 'node_modules', 'ffmpeg-static', 'ffmpeg'));
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function createMediaRelay({ downloadRoot, compatRoot, send, sendFile, log = () => {} }) {
  /** source URL -> { child, dir, kind, stderr, cancelled } */
  const jobs = new Map();
  /** proxy id -> { headers, cookies, createdAt } */
  const sessions = new Map();

  // -------------------------------------------------------------------------
  // ffmpeg discovery
  // -------------------------------------------------------------------------

  function findFfmpeg() {
    return resolveFfmpegPath();
  }

  function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function emit(payload) {
    try {
      send('desktop:compatProgress', payload);
    } catch {
      /* no window listening */
    }
  }

  // -------------------------------------------------------------------------
  // Probe
  // -------------------------------------------------------------------------

  function analyzeProbe(stderr, input) {
    const durationMatch = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
    const duration = durationMatch
      ? Number(durationMatch[1]) * 3600 +
        Number(durationMatch[2]) * 60 +
        Number(durationMatch[3])
      : 0;

    const videoMatch = /Stream #\d+:\d+[^:]*:\s*Video:\s*([a-zA-Z0-9_]+)/.exec(stderr);
    const audioMatch = /Stream #\d+:\d+[^:]*:\s*Audio:\s*([a-zA-Z0-9_]+)/.exec(stderr);
    const video = videoMatch ? videoMatch[1].toLowerCase() : null;
    const audio = audioMatch ? audioMatch[1].toLowerCase() : null;

    let container = extensionOf(input);
    if (/Input #0,\s*matroska/i.test(stderr)) container = 'mkv';
    else if (/Input #0,\s*mpegts/i.test(stderr)) container = 'ts';
    else if (/Input #0,\s*mov,mp4/i.test(stderr)) container = container || 'mp4';

    const containerOk = CONTAINER_OK.has(container);
    const videoOk = !!video && VIDEO_OK.has(video);
    const audioOk = !audio || AUDIO_OK.has(audio);
    const compatible = containerOk && videoOk && audioOk;

    const reasons = [];
    if (!containerOk) reasons.push(`container "${container || 'unknown'}"`);
    if (!videoOk) reasons.push(`video "${video || 'unknown'}"`);
    if (!audioOk) reasons.push(`audio "${audio || 'unknown'}"`);

    return {
      ok: true,
      duration,
      video,
      audio,
      container,
      compatible,
      reason: compatible ? null : `Chromium cannot play ${reasons.join(' + ')}`,
    };
  }

  /**
   * Inspect a local path or remote URL. Resolves even on failure — callers get
   * `{ ok: false, error }` rather than a rejected promise.
   */
  function probe(input, headers, options = {}) {
    return new Promise((resolve) => {
      const ffmpeg = findFfmpeg();
      if (!ffmpeg) {
        resolve({ ok: false, error: 'FFmpeg binary not found' });
        return;
      }

      const args = ['-hide_banner', '-nostdin'];
      const remote = /^https?:/i.test(input);
      if (remote) {
        const normalized = normalizeHeaders(headers);
        if (!hasHeader(normalized, 'user-agent')) {
          args.push('-user_agent', DEFAULT_UA);
        }
        const block = ffmpegHeaderBlock(normalized);
        if (block) args.push('-headers', block);
        args.push('-rw_timeout', '15000000');
      }
      args.push('-i', input);

      let stderr = '';
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };

      let child;
      try {
        child = spawn(ffmpeg, args, { windowsHide: true });
      } catch (err) {
        resolve({ ok: false, error: err.message });
        return;
      }

      const timer = setTimeout(() => {
        killChild(child);
        finish({ ok: false, error: 'probe timeout' });
      }, options.timeoutMs || PROBE_TIMEOUT_MS);

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
        if (stderr.length > 400000) stderr = stderr.slice(-400000);
      });
      child.on('error', (err) => finish({ ok: false, error: err.message }));
      child.on('close', () => {
        if (/No such file or directory|Invalid data found/i.test(stderr)) {
          finish({ ok: false, error: stderr.trim().split(/\r?\n/).pop() || 'unreadable input' });
          return;
        }
        finish(analyzeProbe(stderr, input));
      });
    });
  }

  // -------------------------------------------------------------------------
  // Local files served by the shell (`/__media/...`)
  // -------------------------------------------------------------------------

  function resolveLocalMedia(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (!/^(127\.0\.0\.1|localhost|\[::1\])$/i.test(parsed.hostname)) return null;
    if (!parsed.pathname.startsWith('/__media/')) return null;

    const root = path.resolve(downloadRoot());
    let rel;
    try {
      rel = decodeURIComponent(parsed.pathname.slice('/__media/'.length));
    } catch {
      return null;
    }
    const target = path.resolve(root, rel);
    if (!target.startsWith(root + path.sep) && target !== root) return null;
    try {
      return fs.statSync(target).isFile() ? target : null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Transcode a local file into a seekable MP4
  // -------------------------------------------------------------------------

  function transcodeLocal({ source, filePath, info }) {
    const stat = fs.statSync(filePath);
    const key = sha1(`file|${filePath}|${stat.size}|${Math.round(stat.mtimeMs)}`).slice(0, 20);
    const dir = path.join(compatRoot(), key);
    const outPath = path.join(dir, 'video.mp4');
    const partPath = `${outPath}.part`;
    const url = `/__compat/${key}/video.mp4`;

    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
      log('compat cache hit', key);
      return Promise.resolve({ ok: true, url, kind: 'file', mode: 'transcode', cached: true });
    }

    const ffmpeg = findFfmpeg();
    if (!ffmpeg) return Promise.resolve({ ok: false, error: 'FFmpeg binary not found' });

    ensureDir(dir);
    try {
      fs.rmSync(partPath, { force: true });
    } catch {
      /* ignore */
    }

    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', filePath];
    args.push('-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn');

    if (info.video === 'h264') {
      // No pixel re-encoding needed — remux keeps the original quality and is
      // nearly instant. Only the audio may need a Chromium-friendly codec.
      args.push('-c:v', 'copy');
    } else {
      args.push(
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '21',
        '-pix_fmt', 'yuv420p',
        '-profile:v', 'high',
        '-threads', '0',
      );
    }

    if (!info.audio || AUDIO_OK.has(info.audio)) {
      args.push('-c:a', 'copy');
    } else {
      args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
    }

    args.push('-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', '-f', 'mp4', partPath);

    emit({
      source,
      phase: 'transcode',
      percent: 0,
      message: info.video === 'h264' ? 'Repackaging video…' : 'Converting video…',
    });

    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(ffmpeg, args, { windowsHide: true });
      } catch (err) {
        resolve({ ok: false, error: err.message });
        return;
      }

      const job = { child, dir, kind: 'transcode', stderr: '', cancelled: false };
      jobs.set(source, job);

      let lastEmit = 0;
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() || '';
        for (const line of lines) {
          const match = /^out_time_(?:us|ms)=(\d+)/.exec(line.trim());
          if (!match) continue;
          const seconds = Number(match[1]) / 1e6;
          const now = Date.now();
          if (now - lastEmit < 250) continue;
          lastEmit = now;
          const percent =
            info.duration > 0 ? Math.min(99, (seconds / info.duration) * 100) : null;
          emit({ source, phase: 'transcode', percent, message: 'Converting video…' });
        }
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
        if (stderr.length > 20000) stderr = stderr.slice(-20000);
      });

      const settle = (result) => {
        if (jobs.get(source) === job) jobs.delete(source);
        resolve(result);
      };

      child.on('error', (err) => settle({ ok: false, error: err.message }));
      child.on('close', (code) => {
        if (job.cancelled) {
          settle({ ok: false, error: 'cancelled' });
          return;
        }
        if (code !== 0) {
          try {
            fs.rmSync(partPath, { force: true });
          } catch {
            /* ignore */
          }
          settle({ ok: false, error: stderr.trim().split(/\r?\n/).pop() || `ffmpeg exited ${code}` });
          return;
        }
        try {
          fs.rmSync(outPath, { force: true });
          fs.renameSync(partPath, outPath);
        } catch (err) {
          settle({ ok: false, error: `cannot finalise output: ${err.message}` });
          return;
        }
        const size = fs.statSync(outPath).size;
        emit({ source, phase: 'done', percent: 100, message: `Ready (${mb(size)})` });
        settle({ ok: true, url, kind: 'file', mode: 'transcode' });
      });
    });
  }

  // -------------------------------------------------------------------------
  // HLS proxy (headers + cookies + playlist rewriting)
  // -------------------------------------------------------------------------

  const proxyPath = (id, absoluteUrl) =>
    `/__hls/${id}/${Buffer.from(absoluteUrl, 'utf8').toString('base64url')}`;

  function decodeProxyToken(token) {
    try {
      return Buffer.from(token, 'base64url').toString('utf8');
    } catch {
      return null;
    }
  }

  function rewritePlaylist(text, baseUrl, id) {
    const lines = text.split(/\r?\n/);

    // Drop HEVC variants only when a decodable variant exists.
    const variants = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
      const attrs = parseAttrs(lines[i]);
      let j = i + 1;
      while (j < lines.length && (!lines[j].trim() || lines[j].trim().startsWith('#'))) j += 1;
      if (j >= lines.length) continue;
      variants.push({ tag: i, uri: j, hevc: isHevcCodec(attrs.CODECS) });
    }
    const decodable = variants.filter((variant) => !variant.hevc);
    const skip = new Set();
    if (decodable.length) {
      for (const variant of variants) {
        if (variant.hevc) {
          skip.add(variant.tag);
          skip.add(variant.uri);
        }
      }
    }

    const out = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (skip.has(i)) continue;
      const line = lines[i];

      if (line.startsWith('#')) {
        out.push(
          line.replace(/URI="([^"]*)"/g, (match, uri) => {
            try {
              return `URI="${proxyPath(id, new URL(uri, baseUrl).toString())}"`;
            } catch {
              return match;
            }
          }),
        );
        continue;
      }

      const trimmed = line.trim();
      if (!trimmed) {
        out.push(line);
        continue;
      }
      try {
        out.push(proxyPath(id, new URL(trimmed, baseUrl).toString()));
      } catch {
        out.push(line);
      }
    }
    return out.join('\n');
  }

  async function fetchText(url, headers, cookies) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const requestHeaders = { 'User-Agent': DEFAULT_UA, ...headers };
      if (cookies && cookies.size) {
        requestHeaders.Cookie = [...cookies.entries()]
          .map(([name, value]) => `${name}=${value}`)
          .join('; ');
      }
      const response = await fetch(url, {
        headers: requestHeaders,
        redirect: 'follow',
        signal: controller.signal,
      });
      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status}`, response };
      }
      const text = await response.text();
      return { ok: true, text, response };
    } catch (err) {
      return { ok: false, error: err.name === 'AbortError' ? 'timeout' : err.message };
    } finally {
      clearTimeout(timer);
    }
  }

  function storeCookies(session, response) {
    if (!response || !session) return;
    let list = [];
    try {
      list = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [];
    } catch {
      list = [];
    }
    if (!list.length) {
      const single = response.headers.get('set-cookie');
      if (single) list = [single];
    }
    for (const raw of list) {
      const pair = String(raw).split(';')[0];
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      session.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  async function prepareHlsProxy({ source, headers }) {
    const normalized = normalizeHeaders(headers);
    const session = { headers: normalized, cookies: new Map(), createdAt: Date.now() };

    const inspected = await fetchText(source, normalized, session.cookies);
    if (!inspected.ok) return { ok: false, error: inspected.error };
    storeCookies(session, inspected.response);
    if (!/#EXTM3U/.test(inspected.text)) {
      return { ok: false, error: 'not an HLS playlist' };
    }

    if (/#EXT-X-STREAM-INF/.test(inspected.text)) {
      const codecs = [...inspected.text.matchAll(/#EXT-X-STREAM-INF:([^\r\n]*)/g)].map(
        (match) => parseAttrs(`:${match[1]}`).CODECS || '',
      );
      const hasVideo = codecs.some((value) => /avc1|hvc1|hev1|dvh1|dvhe|vp0?9|av01/i.test(value));
      const hasDecodable = codecs.some((value) => /avc1|vp0?9|av01/i.test(value));
      if (hasVideo && !hasDecodable) {
        // Every video rendition is HEVC (or Dolby Vision) — proxying cannot
        // help, the pixels must be re-encoded.
        return { ok: false, error: 'HEVC-only ladder' };
      }
    }

    const id = crypto.randomBytes(8).toString('hex');
    sessions.set(id, session);

    // Keep the session table small: drop entries nobody has touched for 6h.
    const cutoff = Date.now() - 6 * 60 * 60 * 1000;
    for (const [key, value] of sessions) {
      if (value.createdAt < cutoff) sessions.delete(key);
    }

    return { ok: true, url: proxyPath(id, source), kind: 'hls', mode: 'proxy' };
  }

  async function proxyRemote(req, res, remoteUrl, session) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

    const requestHeaders = { 'User-Agent': DEFAULT_UA, ...session.headers };
    if (session.cookies.size) {
      requestHeaders.Cookie = [...session.cookies.entries()]
        .map(([name, value]) => `${name}=${value}`)
        .join('; ');
    }
    if (req.headers.range) requestHeaders.Range = req.headers.range;

    let upstream;
    try {
      upstream = await fetch(remoteUrl, {
        headers: requestHeaders,
        redirect: 'follow',
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      res.writeHead(502, { 'Access-Control-Allow-Origin': '*' });
      res.end(`upstream error: ${err.message}`);
      return;
    }
    clearTimeout(timer);

    storeCookies(session, upstream);

    if (!upstream.ok && upstream.status !== 206) {
      res.writeHead(upstream.status || 502, { 'Access-Control-Allow-Origin': '*' });
      res.end();
      return;
    }

    let body;
    try {
      body = Buffer.from(await upstream.arrayBuffer());
    } catch (err) {
      res.writeHead(502, { 'Access-Control-Allow-Origin': '*' });
      res.end(`upstream read error: ${err.message}`);
      return;
    }

    const contentType = upstream.headers.get('content-type') || '';
    const looksPlaylist =
      /mpegurl/i.test(contentType) ||
      (body.length > 6 && body.slice(0, 32).toString('latin1').includes('#EXTM3U'));

    if (looksPlaylist) {
      const id = session.id;
      const rewritten = rewritePlaylist(body.toString('utf8'), remoteUrl, id);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(rewritten);
      return;
    }

    const headers = {
      'Content-Type': contentType || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
      'Accept-Ranges': upstream.headers.get('accept-ranges') || 'bytes',
      'Content-Length': body.length,
    };
    const contentRange = upstream.headers.get('content-range');
    if (contentRange) headers['Content-Range'] = contentRange;
    res.writeHead(upstream.status, headers);
    res.end(body);
  }

  // -------------------------------------------------------------------------
  // Live ffmpeg HLS relay (HEVC / AC3 sources, remote MKV, ...)
  // -------------------------------------------------------------------------

  function waitForPlaylist(playlistPath, job, timeoutMs) {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        try {
          const text = fs.readFileSync(playlistPath, 'utf8');
          if (/#EXTINF/.test(text)) {
            resolve({ ok: true });
            return;
          }
        } catch {
          /* not written yet */
        }
        // Check the playlist before the exit code: a short source can finish
        // transcoding before the first poll, and its output is still valid.
        if (job.child.exitCode != null) {
          resolve({ ok: false, error: job.stderr.trim().split(/\r?\n/).pop() || 'ffmpeg exited' });
          return;
        }
        if (Date.now() - started > timeoutMs) {
          resolve({ ok: false, error: 'ffmpeg produced no segments' });
          return;
        }
        setTimeout(tick, 200);
      };
      tick();
    });
  }

  async function startRelay({ source, headers, startAt = 0 }) {
    const ffmpeg = findFfmpeg();
    if (!ffmpeg) return { ok: false, error: 'FFmpeg binary not found' };

    const normalized = normalizeHeaders(headers);
    const key = sha1(`relay|${source}|${JSON.stringify(normalized)}|${startAt}`).slice(0, 20);
    const dir = path.join(compatRoot(), `relay-${key}`);

    // Restarting a relay for the same source replaces the previous process.
    const existing = jobs.get(source);
    if (existing) {
      existing.cancelled = true;
      killChild(existing.child);
      jobs.delete(source);
    }

    ensureDir(dir);
    try {
      for (const entry of fs.readdirSync(dir)) {
        fs.rmSync(path.join(dir, entry), { force: true });
      }
    } catch {
      /* ignore */
    }

    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
    if (startAt > 0) args.push('-ss', String(startAt));
    if (/^https?:/i.test(source)) {
      if (!hasHeader(normalized, 'user-agent')) args.push('-user_agent', DEFAULT_UA);
      const block = ffmpegHeaderBlock(normalized);
      if (block) args.push('-headers', block);
      args.push(
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-rw_timeout', '15000000',
      );
    }
    args.push(
      '-i', source,
      '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '22',
      '-pix_fmt', 'yuv420p',
      '-profile:v', 'high',
      '-threads', '0',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ac', '2',
      '-f', 'hls',
      '-hls_time', '4',
      '-hls_playlist_type', 'event',
      '-hls_list_size', '0',
      '-hls_flags', 'independent_segments',
      '-hls_segment_filename', path.join(dir, 'seg_%05d.ts'),
      path.join(dir, 'index.m3u8'),
    );

    let child;
    try {
      child = spawn(ffmpeg, args, { windowsHide: true });
    } catch (err) {
      return { ok: false, error: err.message };
    }

    const job = { child, dir, kind: 'relay', stderr: '', cancelled: false };
    jobs.set(source, job);

    child.stderr.on('data', (chunk) => {
      job.stderr += chunk.toString();
      if (job.stderr.length > 20000) job.stderr = job.stderr.slice(-20000);
    });
    child.on('close', () => {
      if (jobs.get(source) === job) jobs.delete(source);
    });

    emit({ source, phase: 'relay', percent: null, message: 'Transcoding stream…' });

    const ready = await waitForPlaylist(path.join(dir, 'index.m3u8'), job, RELAY_READY_TIMEOUT_MS);
    if (!ready.ok) {
      job.cancelled = true;
      killChild(child);
      if (jobs.get(source) === job) jobs.delete(source);
      emit({ source, phase: 'error', percent: null, message: ready.error });
      return { ok: false, error: ready.error };
    }

    return { ok: true, url: `/__relay/${key}/index.m3u8`, kind: 'hls', mode: 'relay' };
  }

  // -------------------------------------------------------------------------
  // Public entry point used by the renderer
  // -------------------------------------------------------------------------

  async function preparePlayback(request) {
    const source = String(request?.url || '');
    if (!/^(https?:|file:)/i.test(source)) {
      return { ok: false, error: 'unsupported url' };
    }

    const localPath = resolveLocalMedia(source);
    if (localPath) {
      const info = await probe(localPath);
      if (!info.ok) return { ok: false, error: info.error };
      if (info.compatible) {
        return { ok: true, url: source, kind: 'file', mode: 'passthrough' };
      }
      log('compat transcode:', path.basename(localPath), info.reason);
      return transcodeLocal({ source, filePath: localPath, info });
    }

    const wantsHls =
      /\.m3u8(\?|#|$)/i.test(source) ||
      /[?&]type=m3u8\b/i.test(source) ||
      request?.kind === 'hls';

    if (wantsHls) {
      if (request?.mode !== 'relay') {
        const proxied = await prepareHlsProxy({ source, headers: request?.headers });
        if (proxied.ok) return proxied;
        log('HLS proxy failed, using relay:', proxied.error);
      }
      return startRelay({ source, headers: request?.headers });
    }

    // A remote direct file (mkv/mov/...) cannot be demuxed by Chromium, so it
    // goes straight through the live relay.
    return startRelay({ source, headers: request?.headers });
  }

  function cancel(source) {
    const job = jobs.get(source);
    if (!job) return false;
    job.cancelled = true;
    killChild(job.child);
    jobs.delete(source);
    emit({ source, phase: 'error', percent: null, message: 'cancelled' });
    return true;
  }

  // -------------------------------------------------------------------------
  // Loopback routes
  // -------------------------------------------------------------------------

  function handleRequest(req, res, pathname) {
    // `/__hls/<session>/<base64url>` — proxied playlist or segment.
    const hlsMatch = /^\/__hls\/([a-f0-9]{8,32})\/([A-Za-z0-9_-]+)$/.exec(pathname);
    if (hlsMatch) {
      const session = sessions.get(hlsMatch[1]);
      if (!session) {
        res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
        res.end('proxy session expired');
        return true;
      }
      const remote = decodeProxyToken(hlsMatch[2]);
      if (!remote || !/^https?:/i.test(remote)) {
        res.writeHead(400, { 'Access-Control-Allow-Origin': '*' });
        res.end('bad proxy token');
        return true;
      }
      session.id = hlsMatch[1];
      void proxyRemote(req, res, remote, session);
      return true;
    }

    // `/__relay/<key>/<file>` — ffmpeg's growing HLS output.
    const relayMatch = /^\/__relay\/([a-f0-9]{8,64})\/([^/]+)$/.exec(pathname);
    if (relayMatch) {
      const file = path.resolve(compatRoot(), `relay-${relayMatch[1]}`, relayMatch[2]);
      const root = path.resolve(compatRoot(), `relay-${relayMatch[1]}`);
      if (!file.startsWith(root + path.sep)) {
        res.writeHead(403);
        res.end('forbidden');
        return true;
      }
      if (!fs.existsSync(file)) {
        res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
        res.end('segment not ready');
        return true;
      }
      sendFile(req, res, file, { cacheControl: 'no-store' });
      return true;
    }

    // `/__compat/<key>/<file>` — finished MP4 remux/transcode.
    const compatMatch = /^\/__compat\/([a-f0-9]{8,64})\/([^/]+)$/.exec(pathname);
    if (compatMatch) {
      const file = path.resolve(compatRoot(), compatMatch[1], compatMatch[2]);
      const root = path.resolve(compatRoot(), compatMatch[1]);
      if (!file.startsWith(root + path.sep)) {
        res.writeHead(403);
        res.end('forbidden');
        return true;
      }
      if (!fs.existsSync(file)) {
        res.writeHead(404);
        res.end('not found');
        return true;
      }
      sendFile(req, res, file);
      return true;
    }

    return false;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  function status() {
    return {
      ffmpeg: findFfmpeg(),
      jobs: [...jobs.entries()].map(([source, job]) => ({ source, kind: job.kind })),
      sessions: sessions.size,
    };
  }

  function dispose() {
    for (const job of jobs.values()) {
      job.cancelled = true;
      killChild(job.child);
    }
    jobs.clear();
    sessions.clear();
  }

  return {
    preparePlayback,
    probe,
    cancel,
    handleRequest,
    status,
    dispose,
    findFfmpeg,
  };
}

module.exports = { createMediaRelay, findFfmpeg: resolveFfmpegPath };

/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Dev-only UI probe: launches the packaged app with CDP, walks the UI with
 * *trusted* input events (real mouse clicks / keystrokes), saves screenshots
 * and prints layout + console diagnostics.
 *
 *   node desktop/ui-probe.js home
 *   node desktop/ui-probe.js search "batman"
 *   node desktop/ui-probe.js play
 *   node desktop/ui-probe.js back
 *   node desktop/ui-probe.js screens
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const EXE =
  process.env.COFFE_EXE ||
  path.join(__dirname, 'release', 'win-unpacked', 'CoFFe House stream.exe');
const DEV = process.env.COFFE_DEV === '1';
const DEV_DIR = path.join(__dirname);
const PORT = Number(process.env.COFFE_CDP_PORT || 9444);
const OUT = path.join(__dirname, 'ui-probe');
const MODE = process.argv[2] || 'home';
const ARG = process.argv[3] || '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForTarget(timeoutMs = 90000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      if (res.ok) {
        const targets = await res.json();
        const page = targets.find(
          (t) => t.type === 'page' && /^http:\/\/127\.0\.0\.1:/.test(t.url),
        );
        if (page) return page;
      }
    } catch {
      /* not up yet */
    }
    await sleep(400);
  }
  throw new Error('no target');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', () => reject(new Error('ws error')), { once: true });
  });
}

let nextId = 1;
function cdp(ws, method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.id !== id) return;
      ws.removeEventListener('message', onMessage);
      if (msg.error) return reject(new Error(JSON.stringify(msg.error)));
      resolve(msg.result);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(ws, expression) {
  const result = await cdp(ws, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'eval error');
  }
  return result.result.value;
}

async function shot(ws, name) {
  const result = await cdp(ws, 'Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
  console.log('[shot]', file);
}

/** Real mouse click at viewport coordinates. */
async function clickXY(ws, x, y) {
  await cdp(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await cdp(ws, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await cdp(ws, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
}

/**
 * Page-side helper injected before every interaction: reveals an element by
 * scrolling every scrollable ancestor, then reports a *verified* on-screen
 * point plus the element that actually sits on top of that point.
 */
const REVEAL = `
  window.__reveal = (el) => {
    if (!el) return null;
    let node = el;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 4) {
        const r = el.getBoundingClientRect();
        const nr = node.getBoundingClientRect();
        node.scrollLeft += (r.x + r.width / 2) - (nr.x + nr.width / 2);
      }
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 4) {
        const r = el.getBoundingClientRect();
        const nr = node.getBoundingClientRect();
        node.scrollTop += (r.y + r.height / 2) - (nr.y + nr.height / 2);
      }
      node = node.parentElement;
    }
    el.scrollIntoView({ block: 'center', inline: 'center' });
    return true;
  };
  window.__point = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return { offscreen: true, reason: 'zero-size' };
    const x = Math.min(Math.max(r.x + r.width / 2, 3), window.innerWidth - 3);
    const y = Math.min(Math.max(r.y + r.height / 2, 3), window.innerHeight - 3);
    const top = document.elementFromPoint(x, y);
    const inside = !!(top && (top === el || el.contains(top) || top.contains(el)));
    const chain = [];
    let n = top;
    for (let i = 0; n && i < 5; i += 1) {
      chain.push(n.tagName + (n.getAttribute('role') ? '[' + n.getAttribute('role') + ']' : '') + ':' + (n.textContent || '').trim().slice(0, 24));
      n = n.parentElement;
    }
    return {
      x: Math.round(x), y: Math.round(y),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      onScreen: r.x + r.width > 0 && r.y + r.height > 0 && r.x < window.innerWidth && r.y < window.innerHeight,
      hit: inside,
      top: chain[0],
      chain,
    };
  };
  window.__clickable = (el) => {
    let n = el;
    while (n && n !== document.body) {
      const s = getComputedStyle(n);
      if (n.getAttribute('tabindex') != null || n.getAttribute('role') === 'button' || n.getAttribute('role') === 'link' || s.cursor === 'pointer') return n;
      n = n.parentElement;
    }
    return el;
  };
  window.__byText = (wanted) => {
    const want = String(wanted).toLowerCase();
    const nodes = Array.from(document.querySelectorAll('[role="tab"],[role="button"],button,a,div,span'));
    const matches = nodes.filter((el) => {
      const aria = (el.getAttribute('aria-label') || '').trim().toLowerCase();
      const text = (el.textContent || '').trim().toLowerCase();
      return aria === want || text === want || aria.startsWith(want + ',') || text.startsWith(want + ',');
    });
    // deepest first
    matches.sort((a, b) => b.querySelectorAll('*').length - a.querySelectorAll('*').length);
    return matches[matches.length - 1] || null;
  };
  true;
`;

/** Reveal + verify + click a page element. Returns diagnostic info. */
async function tap(ws, selectorJs) {
  await evaluate(ws, REVEAL);
  const found = await evaluate(
    ws,
    `(() => {
      const el = (${selectorJs});
      if (!el) return null;
      window.__reveal(el);
      return window.__point(el);
    })()`,
  );
  if (!found) return { found: false };
  await sleep(250);
  if (!found.hit || !found.onScreen) return { found: true, ...found, clicked: false };
  await clickXY(ws, found.x, found.y);
  await sleep(150);
  return { found: true, ...found, clicked: true };
}

const LAYOUT = `(() => {
  const root = document.getElementById('root');
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return null;
    const x = Math.min(Math.max(r.x + r.width / 2, 2), window.innerWidth - 2);
    const y = Math.min(Math.max(r.y + r.height / 2, 2), window.innerHeight - 2);
    const top = document.elementFromPoint(x, y);
    if (!top) return null;
    if (!(top === el || el.contains(top))) return null;
    return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) };
  };
  const cards = Array.from(document.querySelectorAll('img')).map(vis).filter(Boolean).slice(0, 30);
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    dpr: window.devicePixelRatio,
    rootWidth: root ? Math.round(root.getBoundingClientRect().width) : null,
    cards,
    columns: (() => {
      const rows = {};
      cards.forEach((c) => { rows[c.y] = (rows[c.y] || 0) + 1; });
      return rows;
    })(),
    text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 240),
  };
})()`;

const VIDEO_STATE = `(() => {
  const v = document.querySelector('video');
  const r = v ? v.getBoundingClientRect() : null;
  const root = document.getElementById('root');
  return {
    video: v ? {
      src: (v.currentSrc || v.src || '').slice(0, 150),
      readyState: v.readyState,
      networkState: v.networkState,
      paused: v.paused,
      t: Number(v.currentTime.toFixed(2)),
      d: Number.isFinite(v.duration) ? Number(v.duration.toFixed(1)) : null,
      w: v.videoWidth, h: v.videoHeight,
      rect: r ? { w: Math.round(r.width), h: Math.round(r.height) } : null,
      error: v.error ? { code: v.error.code, message: v.error.message } : null,
    } : null,
    dom: {
      rootChildren: root ? root.childElementCount : null,
      rootHtml: root ? root.innerHTML.length : null,
      elements: document.querySelectorAll('*').length,
      bodyText: (document.body.innerText || '').length,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      rootBg: root ? getComputedStyle(root).backgroundColor : null,
    },
    tree: root ? Array.from(root.querySelectorAll('div')).slice(0, 3).map((d) => d.className && String(d.className).slice(0, 60)) : null,
    text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 200),
  };
})()`;

(async () => {
  if (!DEV && !fs.existsSync(EXE)) {
    console.log('[fatal] exe missing', EXE);
    process.exit(1);
  }
  const child = DEV
    ? spawn(
        path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe'),
        ['.', `--remote-debugging-port=${PORT}`],
        { cwd: DEV_DIR, stdio: 'ignore' },
      )
    : spawn(EXE, [`--remote-debugging-port=${PORT}`], { stdio: 'ignore' });
  console.log('[spawn]', child.pid, DEV ? '(dev)' : '');

  const logs = [];
  let ws;
  try {
    const page = await waitForTarget();
    ws = await connect(page.webSocketDebuggerUrl);

    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args || [])
          .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type))
          .join(' ');
        logs.push(`${msg.params.type}: ${text}`);
      } else if (msg.method === 'Log.entryAdded') {
        logs.push(`${msg.params.entry.level}: ${msg.params.entry.text}`);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const details = msg.params.exceptionDetails;
        logs.push(
          `EXCEPTION: ${details.text} ${(details.exception && details.exception.description) || ''}`.slice(0, 600),
        );
      }
    });
    await cdp(ws, 'Runtime.enable');
    await cdp(ws, 'Log.enable');
    await cdp(ws, 'Page.enable');
    await cdp(ws, 'Network.enable');
    // Assets are served with `immutable`, so a bundle rewritten under the same
    // hashed name (e.g. after a crashed export) would stay cached forever.
    try {
      await cdp(ws, 'Network.clearBrowserCache');
      await cdp(ws, 'Page.reload', { ignoreCache: true });
      await sleep(1200);
    } catch {
      /* cache APIs unavailable - carry on */
    }

    const started = Date.now();
    let len = 0;
    while (Date.now() - started < 40000) {
      len = await evaluate(ws, 'document.body ? document.body.innerText.length : 0');
      if (len > 200) break;
      await sleep(500);
    }
    console.log('[ready]', len, 'chars in', Date.now() - started, 'ms');
    await evaluate(ws, REVEAL);

    if (MODE === 'home' || MODE === 'screens') {
      console.log('[layout]', JSON.stringify(await evaluate(ws, LAYOUT), null, 2));
      await shot(ws, MODE);
    }

    if (MODE === 'search') {
      console.log('[tab]', JSON.stringify(await tap(ws, `window.__byText('Search')`)));
      await sleep(1200);
      await shot(ws, 'search-empty');
      const dom = await evaluate(ws, `(() => {
        const input = document.querySelector('input');
        const chain = [];
        let n = input;
        for (let i = 0; n && i < 8; i += 1) {
          const r = n.getBoundingClientRect();
          const s = getComputedStyle(n);
          chain.push({
            tag: n.tagName,
            cls: String(n.className || '').slice(0, 50),
            rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
            pos: s.position,
            z: s.zIndex,
            h: s.height,
            mt: s.marginTop,
            ov: s.overflow,
            disp: s.display,
            flex: s.flex,
            kids: n.childElementCount,
            off: n.offsetHeight,
            minH: s.minHeight,
            maxH: s.maxHeight,
          });
          n = n.parentElement;
        }
        const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4')).map((el) => {
          const r = el.getBoundingClientRect();
          return { t: (el.textContent || '').slice(0, 28), rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] };
        });
        const inputs = Array.from(document.querySelectorAll('input')).map((el) => {
          const r = el.getBoundingClientRect();
          const top = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
          return {
            ph: el.placeholder,
            value: el.value,
            rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
            visible: r.width > 0 && r.height > 0,
            top: top ? top.tagName + ':' + (top.textContent || '').trim().slice(0, 24) : null,
          };
        });
        return { chain, headings, inputs };
      })()`);
      console.log('[dom]', JSON.stringify(dom, null, 2));
      const box = await evaluate(ws, `(() => {
        const input = document.querySelector('input');
        if (!input) return null;
        window.__reveal(input);
        return window.__point(input);
      })()`);
      console.log('[input]', JSON.stringify(box));
      if (box) {
        await clickXY(ws, box.x, box.y);
        await sleep(300);
        await cdp(ws, 'Input.insertText', { text: ARG });
        console.log('[typed]', ARG);
        for (let i = 0; i < 6; i += 1) {
          await sleep(1500);
          const state = await evaluate(ws, `(() => {
            const input = document.querySelector('input');
            let n = input;
            while (n && n.getBoundingClientRect().height < window.innerHeight * 0.7) n = n.parentElement;
            const root = n || document.body;
            return {
              value: input ? input.value : null,
              text: (root.innerText || '').replace(/\\s+/g, ' ').slice(0, 260),
              alts: Array.from(root.querySelectorAll('img')).slice(0, 8).map((el) => el.alt),
            };
          })()`);
          console.log(`[after typing ${i}]`, JSON.stringify(state));
          if (state.value === ARG && /batman/i.test(state.text + ' ' + state.alts.join(' '))) break;
        }
        console.log('[layout]', JSON.stringify(await evaluate(ws, LAYOUT), null, 2));
        await shot(ws, 'search-results');
      }
    }

    if (MODE === 'play' || MODE === 'back') {
      const poster = await evaluate(ws, `(() => {
        const img = Array.from(document.querySelectorAll('img')).find((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 60 && r.width < 600 && r.height > r.width * 1.2;
        });
        if (!img) return null;
        const target = window.__clickable(img);
        window.__reveal(target);
        return { alt: img.alt, target: target.tagName + ':' + (target.textContent || '').slice(0, 40), ...window.__point(target) };
      })()`);
      console.log('[poster]', JSON.stringify(poster));
      if (poster && poster.hit) {
        await clickXY(ws, poster.x, poster.y);
        await sleep(6000);
        console.log('[after poster click]', await evaluate(ws, 'document.body.innerText.replace(/\\s+/g," ").slice(0,240)'));
        await shot(ws, 'detail');

        if (MODE === 'back') {
          // The header back arrow is an unlabeled icon button today, so fall
          // back to its pinned top-left position.
          const backBtn = await evaluate(ws, `(() => {
            const el = window.__byText('back') || Array.from(document.querySelectorAll('[role="button"],button'))
              .find((n) => /back|رجوع/i.test((n.getAttribute('aria-label') || '') + (n.textContent || '')));
            if (el) {
              window.__reveal(el);
              return { via: 'label', label: (el.getAttribute('aria-label') || el.textContent || '').slice(0, 30), ...window.__point(el) };
            }
            const x = 36;
            const y = 30;
            const top = document.elementFromPoint(x, y);
            if (!top) return null;
            return { via: 'position', top: top.tagName + ':' + (top.textContent || '').slice(0, 20), x, y, hit: true };
          })()`);
          console.log('[back button]', JSON.stringify(backBtn));
          if (backBtn && backBtn.hit) {
            await clickXY(ws, backBtn.x, backBtn.y);
            await sleep(2500);
            console.log('[after back]', await evaluate(ws, 'document.body.innerText.replace(/\\s+/g," ").slice(0,180)'));
            await shot(ws, 'after-back');
          }
        } else {
          const playBtn = await evaluate(ws, `(() => {
            const el = window.__byText('play') || window.__byText('watch now');
            if (!el) return null;
            window.__reveal(el);
            return { label: (el.textContent || '').slice(0, 30), ...window.__point(el) };
          })()`);
          console.log('[play button]', JSON.stringify(playBtn));
          if (playBtn && playBtn.hit) {
            await clickXY(ws, playBtn.x, playBtn.y);
            for (let i = 0; i < 20; i += 1) {
              await sleep(2500);
              const state = await evaluate(ws, VIDEO_STATE);
              console.log(`[state ${i}]`, JSON.stringify(state));
              if (logs.length) console.log('[logs]', logs.slice(-4).join(' | ').slice(0, 700));
              if (state.video && state.video.readyState >= 2) break;
            }
            await shot(ws, 'player');

            // In-player back control: the reported "back doesn't work" case.
            const playerBack = await evaluate(ws, `(() => {
              const all = Array.from(document.querySelectorAll('[aria-label],[role="button"],button'))
                .filter((n) => /^back$/i.test((n.getAttribute('aria-label') || '').trim()));
              if (!all.length) return null;
              // Several screens stay mounted in the stack; take the biggest
              // (i.e. the one actually laid out on top).
              const el = all
                .map((n) => ({ n, area: n.getBoundingClientRect().width * n.getBoundingClientRect().height }))
                .sort((a, b) => b.area - a.area)[0].n;
              window.__reveal(el);
              return { count: all.length, label: el.getAttribute('aria-label'), ...window.__point(el) };
            })()`);
            console.log('[player back]', JSON.stringify(playerBack));
            const backDom = await evaluate(ws, `(() => {
              const el = Array.from(document.querySelectorAll('[aria-label]'))
                .find((n) => /^back$/i.test((n.getAttribute('aria-label') || '').trim()));
              if (!el) return null;
              const r = el.getBoundingClientRect();
              const chain = [];
              let n = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
              for (let i = 0; n && i < 8; i += 1) {
                const s = getComputedStyle(n);
                const rr = n.getBoundingClientRect();
                chain.push({
                  tag: n.tagName,
                  cls: String(n.className || '').slice(0, 60),
                  pe: s.pointerEvents,
                  z: s.zIndex,
                  op: s.opacity,
                  rect: [Math.round(rr.x), Math.round(rr.y), Math.round(rr.width), Math.round(rr.height)],
                  isBtn: n === el,
                  containsBtn: n.contains(el),
                });
                n = n.parentElement;
              }
              const bs = getComputedStyle(el);
              return {
                btn: { pe: bs.pointerEvents, op: bs.opacity, vis: bs.visibility, z: bs.zIndex },
                chain,
              };
            })()`);
            console.log('[player back dom]', JSON.stringify(backDom));
            if (playerBack && playerBack.hit) {
              await clickXY(ws, playerBack.x, playerBack.y);
              await sleep(2500);
              const after = await evaluate(ws, `(() => ({
                video: !!document.querySelector('video'),
                text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 160),
              }))()`);
              console.log('[after player back]', JSON.stringify(after));
              await shot(ws, 'after-player-back');
            }
          }
        }
      }
    }

    console.log('[console]', logs.length, 'messages');
    for (const line of logs.slice(-30)) console.log('  ', line.slice(0, 400));
  } catch (error) {
    console.log('[fatal]', error.message);
  } finally {
    try {
      ws && ws.close();
    } catch {
      /* ignore */
    }
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
})();

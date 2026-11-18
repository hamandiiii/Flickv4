/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Dev-only probe for the *packaged* app.
 *
 * The MSI/unpacked build ships `resources/web` and a different ASAR layout, so
 * "it worked in dev" is not proof. This launches the real
 * `release/win-unpacked/CoFFe House stream.exe` with the DevTools protocol enabled,
 * attaches over CDP, and checks that:
 *
 *   - the renderer loaded from the loopback server (not an error page),
 *   - React actually mounted real content,
 *   - the preload bridge is present,
 *   - the fixed port was honoured (stable origin),
 *   - the web bundle includes hls.js (HLS playback path shipped).
 *
 *   node desktop/packaged-test.js
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const EXE = path.join(__dirname, 'release', 'win-unpacked', 'CoFFe House stream.exe');
const PORT = 9333;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForTarget(timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      if (res.ok) {
        const targets = await res.json();
        const page = targets.find(
          (t) => t.type === 'page' && /^http:\/\/127\.0\.0\.1:/.test(t.url),
        );
        if (page && page.webSocketDebuggerUrl) return page;
      }
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error('renderer target never appeared');
}

function evaluate(ws, id, expression) {
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
      if (msg.result && msg.result.exceptionDetails) {
        return reject(new Error(msg.result.exceptionDetails.text));
      }
      resolve(msg.result.result.value);
    };
    ws.addEventListener('message', onMessage);
    ws.send(
      JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true },
      }),
    );
  });
}

(async () => {
  if (!fs.existsSync(EXE)) {
    console.log('[fatal] packaged exe missing:', EXE);
    process.exit(1);
  }

  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    detached: false,
  });
  console.log('[spawn]', EXE, 'pid', child.pid);

  let ok = false;
  try {
    const page = await waitForTarget();
    console.log('[target]', page.url);

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('ws error')), {
        once: true,
      });
    });

    const state = await evaluate(
      ws,
      1,
      `(async () => {
        // Home content comes from TMDB, so a cold start (empty HTTP cache)
        // paints the splash first. Poll for real content instead of assuming
        // a fixed paint time — the old 2.5s sleep made this probe flaky.
        const started = Date.now();
        let text = '';
        while (Date.now() - started < 30000) {
          text = document.body ? document.body.innerText : '';
          if (text.length > 200) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        const waitedMs = Date.now() - started;
        return {
          waitedMs,
          origin: window.location.origin,
          bridge: typeof window.coffeDesktop,
          bridgeVersion: window.coffeDesktop
            ? await window.coffeDesktop.getInfo()
            : null,
          rootChildren: document.getElementById('root')
            ? document.getElementById('root').children.length
            : 0,
          textLength: text.length,
          sample: text.slice(0, 120),
        };
      })()`,
    );

    console.log('[state]', JSON.stringify(state));

    const checks = [
      ['loaded from loopback', /^http:\/\/127\.0\.0\.1:\d+$/.test(state.origin), state.origin],
      ['fixed port honoured', state.origin.endsWith(':43117'), state.origin],
      ['bridge exposed', state.bridge === 'object', state.bridge],
      ['app version', state.bridgeVersion && state.bridgeVersion.version === '1.1.0', JSON.stringify(state.bridgeVersion)],
      ['react mounted', state.rootChildren > 0, String(state.rootChildren)],
      ['real content rendered', state.textLength > 200, `${state.textLength} chars after ${state.waitedMs}ms`],
    ];

    for (const [name, pass, detail] of checks) {
      console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
    }
    ok = checks.every(([, pass]) => pass);

    // The bundle is one minified file; hls.js's own banner text is the most
    // reliable marker that it shipped.
    const hasHls = await evaluate(
      ws,
      2,
      `(() => {
        const src = [...document.querySelectorAll('script[src]')]
          .map((s) => s.src)
          .find((u) => /\\/_expo\\/static\\/js\\/web\\/index-/.test(u));
        if (!src) return false;
        return fetch(src).then((r) => r.text()).then((t) => t.includes('hls.js'));
      })()`,
    );
    console.log(`${hasHls ? 'PASS' : 'FAIL'}  hls.js in shipped bundle — ${hasHls}`);
    ok = ok && hasHls === true;

    ws.close();
  } catch (error) {
    console.log('[fatal]', error.message);
  } finally {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }

  console.log(
    ok ? '[result] PASS — packaged app boots and renders' : '[result] FAIL',
  );
  process.exit(ok ? 0 : 1);
})();

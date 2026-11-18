/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Stream-scraper bridge for the hidden Electron `<webview>`.
 *
 * The shared scraper script (the same one used on iOS/Android) reports findings
 * with `window.ReactNativeWebView.postMessage(payload)`. Electron's `<webview>`
 * has no such bridge, and — more importantly — it has no
 * `injectedJavaScriptBeforeContentLoaded`, so a naive `executeJavaScript` on
 * `dom-ready` runs *after* the embed page already issued its API call.
 *
 * We therefore install the script through the DevTools protocol:
 *
 *   Page.addScriptToEvaluateOnNewDocument({ source, runImmediately: true })
 *
 * That runs the script in every frame (top document *and* cross-origin
 * subframes) before any of the page's own JavaScript, which is what the
 * fetch/XHR/`<video>.src` hooks need. `runImmediately` also covers documents
 * that were already loading when we attached.
 *
 * Messages come back out through `console.log('__COFFE_MSG__' + payload)`
 * because that is the one channel Chromium exposes for *all* frames — `ipc`
 * would only cover a preloaded top frame.
 */
const { webContents } = require('electron');

/** Prefix that marks a console line as a scraper message. */
const MESSAGE_PREFIX = '__COFFE_MSG__';

/** webContentsId -> session */
const sessions = new Map();

/**
 * Build the source we register on every new document: a
 * `window.ReactNativeWebView` shim followed by the shared scraper script.
 */
function buildSource(script) {
  return [
    '(function () {',
    '  try {',
    '    if (window.ReactNativeWebView && window.ReactNativeWebView.__coffe) return;',
    '    var send = function (payload) {',
    '      try {',
    "        var text = typeof payload === 'string' ? payload : JSON.stringify(payload);",
    "        console.log('" + MESSAGE_PREFIX + "' + text);",
    '      } catch (e) {}',
    '    };',
    '    window.ReactNativeWebView = { postMessage: send, __coffe: true };',
    '  } catch (e) {}',
    '})();',
    '',
    script || '',
  ].join('\n');
}

/**
 * `console-message` changed shape in Electron 36: it used to be
 * `(event, level, message, line, sourceId)` and is now
 * `(event, details)`. Support both so a minor Electron bump cannot silently
 * break playback.
 */
function extractMessage(args) {
  const first = args[0];
  if (first && typeof first === 'object' && typeof first.message === 'string') {
    return first.message;
  }
  if (typeof args[1] === 'string') return args[1];
  return null;
}

function makeConsoleHandler(session) {
  return (_event, ...args) => {
    const message = extractMessage(args);
    if (!message) return;
    const at = message.indexOf(MESSAGE_PREFIX);
    if (at === -1) return;
    const data = message.slice(at + MESSAGE_PREFIX.length);
    if (!data) return;
    if (!session.host.isDestroyed()) {
      session.host.send('desktop:scraperMessage', {
        id: session.id,
        data,
      });
    }
  };
}

/**
 * Attach to a `<webview>` guest and start injecting the scraper script.
 *
 * @param {Electron.WebContents} host  the app window's webContents
 * @param {number} id                  the webview's webContents id
 * @param {string} script              the shared scraper script
 * @returns {Promise<boolean>} true when the before-load hook is active
 */
async function attach(host, id, script) {
  detach(id);

  const wc = webContents.fromId(id);
  if (!wc || wc.isDestroyed()) return false;

  const session = {
    id,
    wc,
    host,
    script,
    scriptIdentifier: null,
    onConsoleMessage: null,
    usingDebugger: false,
  };
  sessions.set(id, session);

  session.onConsoleMessage = makeConsoleHandler(session);
  wc.on('console-message', session.onConsoleMessage);
  wc.once('destroyed', () => detach(id));

  const source = buildSource(script);

  // Preferred path: real before-load injection into every frame.
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    session.usingDebugger = true;
    await wc.debugger.sendCommand('Page.enable');
    const result = await wc.debugger.sendCommand(
      'Page.addScriptToEvaluateOnNewDocument',
      { source, runImmediately: true },
    );
    session.scriptIdentifier = result && result.identifier;
    return true;
  } catch (err) {
    // DevTools being open, or a hardened build, can block the debugger.
    // Fall back to injecting as soon as the document is ready — the
    // `<video>.src` hook still catches playback, we just lose some early
    // fetch/XHR calls.
    session.usingDebugger = false;
    try {
      wc.debugger.detach();
    } catch {
      /* not attached */
    }
    console.warn('[coffe] scraper debugger unavailable, falling back:', err && err.message);
  }

  const injectFallback = () => {
    if (wc.isDestroyed()) return;
    wc.executeJavaScript(source, true).catch(() => {
      /* frame may be gone */
    });
  };
  session.fallbackInject = injectFallback;
  wc.on('dom-ready', injectFallback);
  wc.on('did-frame-finish-load', injectFallback);

  return false;
}

/**
 * Tear down a session. Safe to call for unknown ids.
 */
function detach(id) {
  const session = sessions.get(id);
  if (!session) return false;
  sessions.delete(id);

  const { wc } = session;
  if (wc.isDestroyed()) return true;

  if (session.onConsoleMessage) {
    wc.removeListener('console-message', session.onConsoleMessage);
  }
  if (session.fallbackInject) {
    wc.removeListener('dom-ready', session.fallbackInject);
    wc.removeListener('did-frame-finish-load', session.fallbackInject);
  }
  if (session.usingDebugger) {
    const identifier = session.scriptIdentifier;
    try {
      if (identifier) {
        wc.debugger
          .sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier })
          .catch(() => {});
      }
      if (wc.debugger.isAttached()) wc.debugger.detach();
    } catch {
      /* already gone */
    }
  }
  return true;
}

/** Detach every session — called on shutdown. */
function detachAll() {
  for (const id of Array.from(sessions.keys())) detach(id);
}

module.exports = { attach, detach, detachAll, MESSAGE_PREFIX };

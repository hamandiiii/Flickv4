/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Dev-only end-to-end probe for the Windows shell.
 *
 * Boots the *real* main process (so IPC, the local server, session tweaks and
 * window setup are all exercised), then drives the UI from the outside:
 * checks the desktop bridge, opens Settings, opens the storage screen and
 * verifies the chosen path round-trips.
 *
 *   npx electron desktop/smoke-test.js
 *
 * Writes `desktop/smoke/console.log` and `desktop/smoke/settings.png`.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT_DIR = path.join(__dirname, 'smoke');
const logs = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Boot the production shell (registers IPC, starts the server, opens a window).
require('./main.js');

app.whenReady().then(async () => {
  let win = null;
  for (let i = 0; i < 150 && !win; i += 1) {
    win = BrowserWindow.getAllWindows()[0] || null;
    if (!win) await sleep(100);
  }
  if (!win) {
    console.log('[fatal] no window was created');
    process.exit(1);
    return;
  }

  win.webContents.on('console-message', (_event, ...args) => {
    const first = args[0];
    const message =
      first && typeof first === 'object' && typeof first.message === 'string'
        ? `${first.level}: ${first.message}`
        : String(args[1] ?? '');
    logs.push(message);
    console.log('[renderer]', message);
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    console.log('[fatal] renderer gone:', JSON.stringify(details));
  });

  await sleep(16000);

  const dom = await win.webContents.executeJavaScript(
    `(() => {
      const text = (document.body.innerText || '').replace(/\\s+/g, ' ').trim();
      return {
        rootChildren: document.getElementById('root')?.children.length ?? -1,
        htmlLength: document.body.innerHTML.length,
        text: text.slice(0, 200),
      };
    })()`,
  );
  console.log('[dom]', JSON.stringify(dom));

  // 1. Bridge round-trip (preload -> IPC -> disk -> back).
  const storageBefore = await win.webContents.executeJavaScript(
    'window.coffeDesktop.getStorage()',
  );
  console.log('[storage before]', JSON.stringify(storageBefore));

  const probeDir = path.join(os.tmpdir(), 'coffe-smoke-storage');
  const storageSet = await win.webContents.executeJavaScript(
    `window.coffeDesktop.setStorage(${JSON.stringify(probeDir)})`,
  );
  console.log('[storage set]', JSON.stringify(storageSet));

  const storageAfter = await win.webContents.executeJavaScript(
    'window.coffeDesktop.getStorage()',
  );
  console.log('[storage after]', JSON.stringify(storageAfter));

  const storageReset = await win.webContents.executeJavaScript(
    'window.coffeDesktop.resetStorage()',
  );
  console.log('[storage reset]', JSON.stringify(storageReset));

  // 1b. Preferences round-trip (close-to-tray), persisted by the shell.
  const prefsBefore = await win.webContents.executeJavaScript(
    'window.coffeDesktop.getPreferences()',
  );
  console.log('[prefs before]', JSON.stringify(prefsBefore));
  const prefsOff = await win.webContents.executeJavaScript(
    'window.coffeDesktop.setPreferences({ closeToTray: false })',
  );
  const prefsRead = await win.webContents.executeJavaScript(
    'window.coffeDesktop.getPreferences()',
  );
  const prefsOn = await win.webContents.executeJavaScript(
    'window.coffeDesktop.setPreferences({ closeToTray: true })',
  );
  console.log('[prefs off]', JSON.stringify(prefsOff));
  console.log('[prefs read]', JSON.stringify(prefsRead));
  console.log('[prefs on]', JSON.stringify(prefsOn));
  const prefsOk =
    prefsOff.closeToTray === false &&
    prefsRead.closeToTray === false &&
    prefsOn.closeToTray === true;
  console.log(`${prefsOk ? 'PASS' : 'FAIL'}  close-to-tray preference round-trip`);

  // 2. Navigate: Home -> Settings -> Storage location.
  const clickByLabel = async (label) => {
    const point = await win.webContents.executeJavaScript(
      `(() => {
        const nodes = Array.from(document.querySelectorAll('[role="tab"],[role="button"],a,div,span'));
        const target = nodes.find((el) => {
          const aria = (el.getAttribute('aria-label') || '').trim().toLowerCase();
          const text = (el.textContent || '').trim().toLowerCase();
          return aria === ${JSON.stringify(label.toLowerCase())} || text === ${JSON.stringify(label.toLowerCase())};
        });
        if (!target) return null;
        target.scrollIntoView({ block: 'center' });
        const rect = target.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`,
    );
    if (!point) return false;
    await win.webContents.executeJavaScript(
      `(() => {
        const el = document.elementFromPoint(${point.x}, ${point.y});
        if (!el) return false;
        const opts = { bubbles: true, cancelable: true, clientX: ${point.x}, clientY: ${point.y}, button: 0, pointerId: 1, isPrimary: true };
        el.dispatchEvent(new PointerEvent('pointerdown', opts));
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new PointerEvent('pointerup', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('click', opts));
        return true;
      })()`,
    );
    await sleep(1500);
    return true;
  };

  const openedSettings = await clickByLabel('Settings');
  console.log('[open settings]', openedSettings);
  const settingsText = await win.webContents.executeJavaScript(
    `(document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 600)`,
  );
  console.log('[settings text]', settingsText);

  const openedStorage = await clickByLabel('Storage location');
  console.log('[open storage]', openedStorage);
  const storageText = await win.webContents.executeJavaScript(
    `(document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 600)`,
  );
  console.log('[storage screen text]', storageText);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT_DIR, 'settings.png'), image.toPNG());
  fs.writeFileSync(path.join(OUT_DIR, 'console.log'), logs.join('\n'), 'utf8');

  fs.rmSync(probeDir, { recursive: true, force: true });
  process.exit(prefsOk ? 0 : 1);
});

/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Dev-only probe: does the app's origin (and therefore its localStorage) stay
 * stable across launches?
 *
 * AsyncStorage on web is `window.localStorage`, which is scoped to the page
 * origin — `http://127.0.0.1:<port>`. An ephemeral port would silently wipe
 * settings, watch history and the download list on every start, so the shell
 * pins a preferred port. This test runs the app twice and checks a marker
 * survives.
 *
 *   npx electron desktop/persistence-test.js --write
 *   npx electron desktop/persistence-test.js --read
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

require('./main.js');

const MODE = process.argv.includes('--read') ? 'read' : 'write';
const MARKER = path.join(__dirname, 'smoke', 'persist-marker.json');

app.whenReady().then(async () => {
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

  const origin = await win.webContents.executeJavaScript('window.location.origin');

  if (MODE === 'write') {
    const token = `persist-${Date.now()}`;
    await win.webContents.executeJavaScript(
      `localStorage.setItem('__persist_probe', ${JSON.stringify(token)});`,
    );
    fs.mkdirSync(path.dirname(MARKER), { recursive: true });
    fs.writeFileSync(MARKER, JSON.stringify({ origin, token }), 'utf8');
    console.log('[write] origin =', origin, 'token =', token);
    process.exit(0);
    return;
  }

  const expected = fs.existsSync(MARKER)
    ? JSON.parse(fs.readFileSync(MARKER, 'utf8'))
    : null;
  const actual = await win.webContents.executeJavaScript(
    "localStorage.getItem('__persist_probe')",
  );

  const ok = !!expected && actual === expected.token && origin === expected.origin;
  console.log('[read] origin =', origin);
  console.log('[read] expected =', expected && expected.token, 'actual =', actual);
  console.log(
    ok
      ? `[result] PASS — origin and localStorage survived a restart (${origin})`
      : '[result] FAIL — origin or localStorage changed between launches',
  );

  await win.webContents.executeJavaScript(
    "localStorage.removeItem('__persist_probe');",
  );
  fs.rmSync(MARKER, { force: true });
  process.exit(ok ? 0 : 1);
});

app.on('window-all-closed', () => app.quit());

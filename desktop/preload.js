/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Preload for the app window. Exposes a tiny, explicit desktop API on
 * `window.coffeDesktop`. Everything is promise-based and safe to call from
 * React (no node integration leaks into the renderer).
 */
const { contextBridge, ipcRenderer } = require('electron');

const storageListeners = new Set();
const scraperListeners = new Set();
const downloadListeners = new Set();

ipcRenderer.on('desktop:storage-changed', (_event, payload) => {
  for (const fn of storageListeners) {
    try {
      fn(payload);
    } catch {
      /* listener errors must not break the bridge */
    }
  }
});

ipcRenderer.on('desktop:scraperMessage', (_event, payload) => {
  for (const fn of scraperListeners) {
    try {
      fn(payload);
    } catch {
      /* listener errors must not break the bridge */
    }
  }
});

ipcRenderer.on('desktop:downloadProgress', (_event, payload) => {
  for (const fn of downloadListeners) {
    try {
      fn(payload);
    } catch {
      /* listener errors must not break the bridge */
    }
  }
});

contextBridge.exposeInMainWorld('coffeDesktop', {
  isDesktop: true,
  platform: process.platform,

  /** Current storage/download folder + the platform default. */
  getStorage: () => ipcRenderer.invoke('desktop:getStorage'),

  /** Opens the native folder picker. Resolves { canceled, dir, defaultDir }. */
  chooseStorage: () => ipcRenderer.invoke('desktop:chooseStorage'),

  /** Sets an explicit path (used by the manual path field). */
  setStorage: (dir) => ipcRenderer.invoke('desktop:setStorage', dir),

  /** Restores the platform default folder. */
  resetStorage: () => ipcRenderer.invoke('desktop:resetStorage'),

  /** Opens the folder in Explorer. */
  openStorage: () => ipcRenderer.invoke('desktop:openStorage'),

  /** Subscribe to storage changes made elsewhere (menu, second window). */
  onStorageChanged: (fn) => {
    storageListeners.add(fn);
    return () => storageListeners.delete(fn);
  },

  openExternal: (url) => ipcRenderer.invoke('desktop:openExternal', url),
  getInfo: () => ipcRenderer.invoke('desktop:info'),
  toggleFullscreen: () => ipcRenderer.invoke('desktop:toggleFullscreen'),
  minimize: () => ipcRenderer.invoke('desktop:minimize'),
  close: () => ipcRenderer.invoke('desktop:close'),

  // --- stream scraper (hidden <webview> bridge) -----------------------------
  /** Installs the scraper hooks in a webview guest before page load. */
  attachScraper: (id, script) =>
    ipcRenderer.invoke('desktop:scraperAttach', id, script),
  /** Removes the hooks and detaches the debugger. */
  detachScraper: (id) => ipcRenderer.invoke('desktop:scraperDetach', id),
  /** Subscribe to payloads posted by the scraper script. */
  onScraperMessage: (fn) => {
    scraperListeners.add(fn);
    return () => scraperListeners.delete(fn);
  },

  // --- media downloads ------------------------------------------------------
  /** Starts a download into `<storage>/downloads/<folder>`. */
  downloadStart: (request) =>
    ipcRenderer.invoke('desktop:downloadStart', request),
  /** Aborts an in-flight download by id. */
  downloadCancel: (id) => ipcRenderer.invoke('desktop:downloadCancel', id),
  /** Deletes a finished/aborted job folder. */
  downloadRemove: (folder) =>
    ipcRenderer.invoke('desktop:downloadRemove', folder),
  /** Opens the job folder (or the downloads root) in Explorer. */
  downloadReveal: (folder) =>
    ipcRenderer.invoke('desktop:downloadReveal', folder),
  /** Subscribe to download progress events. */
  onDownloadProgress: (fn) => {
    downloadListeners.add(fn);
    return () => downloadListeners.delete(fn);
  },
});

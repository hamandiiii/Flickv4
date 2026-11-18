/**
 * Types for the Windows desktop shell bridge (see `desktop/preload.js`).
 *
 * The bridge only exists when the app runs inside the Electron shell, so every
 * consumer must treat `window.coffeDesktop` as optional.
 */

export interface DesktopStorageInfo {
  dir: string;
  defaultDir: string;
}

export interface DesktopStorageResult extends DesktopStorageInfo {
  canceled: boolean;
}

export interface DesktopInfo {
  version: string;
  platform: string;
  electron: string;
  isDev: boolean;
}

export interface DesktopPreferences {
  /** Closing the window hides the app to the notification area. */
  closeToTray: boolean;
}

export interface DesktopScraperMessage {
  /** webContents id of the guest that posted the message. */
  id: number;
  /** Raw string payload from `window.ReactNativeWebView.postMessage`. */
  data: string;
}

export interface DesktopDownloadRequest {
  /** Stable job id — also used as the folder name when `folder` is absent. */
  id: string;
  url: string;
  /** Folder name inside `<storage>/downloads`. */
  folder?: string;
  headers?: Record<string, string>;
  kind?: 'hls' | 'file';
  /**
   * Keep the bytes already on disk and continue from there (segments for HLS,
   * a `.part` file for direct downloads) instead of starting over.
   */
  resume?: boolean;
}

export interface DesktopSaveSubtitleRequest {
  /** Job folder inside `<storage>/downloads`. */
  folder: string;
  /** ISO 639-1 language code — used as the file name. */
  language: string;
  /** WebVTT body. */
  text: string;
}

export type DesktopDownloadStatus =
  | 'downloading'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface DesktopDownloadProgress {
  id: string;
  status: DesktopDownloadStatus;
  received?: number;
  total?: number;
  completedSegments?: number;
  totalSegments?: number;
  /** Present when `status === 'completed'`. */
  file?: string;
  kind?: 'hls' | 'file';
  folder?: string;
  /** Present when `status === 'failed'`. */
  error?: string;
}

export interface DesktopDownloadStartResult {
  ok: boolean;
  folder?: string;
  error?: string;
}

/** How the compatibility engine made a source playable. */
export type DesktopCompatMode =
  | 'passthrough'
  | 'proxy'
  | 'transcode'
  | 'relay';

export interface DesktopPreparePlaybackRequest {
  /** Original source URL (remote stream or the shell's `/__media/...` URL). */
  url: string;
  /** Headers the stream origin requires (Referer/Origin/Cookie/...). */
  headers?: Record<string, string>;
  /** `hls` lets the shell treat an extension-less playlist URL correctly. */
  kind?: 'hls';
  /** Force the live relay instead of trying the header proxy first. */
  mode?: 'proxy' | 'relay';
}

export interface DesktopPreparePlaybackResult {
  ok: boolean;
  /** Playable URL to hand back to the player (relative to the shell origin). */
  url?: string;
  kind?: 'hls' | 'file';
  mode?: DesktopCompatMode;
  /** True when a previous conversion was reused from disk. */
  cached?: boolean;
  error?: string;
}

export interface DesktopCompatProgress {
  /** Original source URL this conversion belongs to. */
  source: string;
  phase: 'transcode' | 'relay' | 'done' | 'error';
  /** 0-100 while converting; `null`/absent for an indeterminate relay. */
  percent?: number | null;
  message?: string;
}

export interface DesktopCompatStatus {
  /** Absolute path of the bundled ffmpeg binary, or null when missing. */
  ffmpeg: string | null;
  jobs: Array<{ source: string; kind: 'transcode' | 'relay' }>;
  sessions: number;
}

export interface CoffeDesktopBridge {
  isDesktop: true;
  platform: string;
  getStorage(): Promise<DesktopStorageInfo>;
  chooseStorage(): Promise<DesktopStorageResult>;
  setStorage(dir: string): Promise<DesktopStorageResult>;
  resetStorage(): Promise<DesktopStorageResult>;
  openStorage(): Promise<{ ok: boolean; error?: string }>;
  onStorageChanged(fn: (info: DesktopStorageInfo) => void): () => void;
  openExternal(url: string): Promise<boolean>;
  getInfo(): Promise<DesktopInfo>;
  toggleFullscreen(): Promise<boolean>;
  minimize(): Promise<void>;
  close(): Promise<void>;
  /** Shell preferences (close-to-tray). */
  getPreferences(): Promise<DesktopPreferences>;
  setPreferences(patch: Partial<DesktopPreferences>): Promise<DesktopPreferences>;
  onPreferencesChanged(fn: (prefs: DesktopPreferences) => void): () => void;
  /** Installs the scraper hooks inside a `<webview>` guest. */
  attachScraper(id: number, script: string): Promise<boolean>;
  /** Removes the hooks and detaches the debugger. */
  detachScraper(id: number): Promise<boolean>;
  /** Subscribe to payloads posted by the scraper script. */
  onScraperMessage(fn: (message: DesktopScraperMessage) => void): () => void;
  /** Starts a media download into the chosen storage folder. */
  downloadStart(request: DesktopDownloadRequest): Promise<DesktopDownloadStartResult>;
  /** Aborts an in-flight download. */
  downloadCancel(id: string): Promise<boolean>;
  /** Deletes a job folder from disk. */
  downloadRemove(folder: string): Promise<boolean>;
  /** Reveals a job folder (or the downloads root) in Explorer. */
  downloadReveal(folder?: string): Promise<{ ok: boolean; error?: string }>;
  /** Subscribe to download progress events. */
  onDownloadProgress(fn: (progress: DesktopDownloadProgress) => void): () => void;
  /** Writes an offline subtitle sidecar next to a completed download. */
  saveSubtitle(
    request: DesktopSaveSubtitleRequest,
  ): Promise<{ ok: boolean; file?: string; error?: string }>;
  /** FFmpeg compatibility engine: resolve a playable URL after a failure. */
  preparePlayback(
    request: DesktopPreparePlaybackRequest,
  ): Promise<DesktopPreparePlaybackResult>;
  /** Stops a conversion/relay for a source (player unmounted). */
  compatCancel(source: string): Promise<boolean>;
  /** Diagnostics for the settings screen. */
  compatStatus(): Promise<DesktopCompatStatus>;
  /** Subscribe to conversion/relay progress. */
  onCompatProgress(fn: (progress: DesktopCompatProgress) => void): () => void;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Window {
    coffeDesktop?: CoffeDesktopBridge;
  }
}

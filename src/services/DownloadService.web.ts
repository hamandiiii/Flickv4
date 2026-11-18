import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ReactVideoSource } from 'react-native-video';
import type { PlaybackServer } from '@/src/hooks/useServers';
import type { ServerResolver } from '@/src/services/playbackHeaders';
import { STREAMFLIX_PLAYBACK_HEADERS } from '@/src/services/StreamflixService';
import { VdrkSubtitleService } from '@/src/services/VdrkSubtitleService';
import { WyzieService } from '@/src/services/WyzieService';
import type { MediaItem } from '@/src/types';
import { originOf } from '@/src/utils/streamUrl';

/**
 * Desktop (Electron) download engine.
 *
 * The native implementation streams segments with `expo-file-system` and
 * bundles a background downloader; neither exists on the web. Instead the
 * Electron main process owns the byte-moving (see `desktop/main.js`) and this
 * service only keeps the job list, the UI state and the local playback URLs.
 *
 * Downloads land in `<storage>/downloads/<job id>/` and are served back to the
 * renderer by the shell's loopback HTTP server at `/__media/<folder>/<file>`,
 * which is why the local URI is an `http://127.0.0.1:<port>` URL and not a
 * `file://` one: Chromium will not play HLS from `file://`, and the server
 * implements `Range` so seeking works.
 */

// ---------------------------------------------------------------------------
// Types (kept identical to the native service so callers compile unchanged)
// ---------------------------------------------------------------------------

export type DownloadStatus =
  | 'queued'
  | 'resolving'
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'failed';

/** Local subtitle sidecar bundled with a completed download. */
export interface LocalDownloadedSubtitle {
  id: string;
  language: string;
  display: string;
  localUri: string;
  isHearingImpaired?: boolean;
}

export interface DownloadJob {
  id: string;
  item: MediaItem;
  season?: number;
  episode?: number;
  title: string;
  qualityHeight: number;
  qualityLabel: string;
  status: DownloadStatus;
  /** Kind of media on disk (drives which player source we return). */
  kind: 'hls' | 'file';
  /** Original resolved stream URL from the scraper. */
  streamUri?: string;
  /** HLS variant playlist we picked (if HLS). */
  variantUri?: string;
  /** Total segments to download (HLS). 1 for direct-file. */
  totalSegments: number;
  completedSegments: number;
  completedSegmentIndices?: number[];
  bytesWritten: number;
  totalBytes: number;
  /** Folder URL holding the download (served by the desktop shell). */
  localDir: string;
  /** Local playable URI once the job completes. */
  localUri?: string;
  subtitleLanguage?: string;
  subtitles?: LocalDownloadedSubtitle[];
  headers: Record<string, string>;
  serverId?: string;
  serverName?: string;
  server?: PlaybackServer;
  imdbId?: string | null;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ResolveRequest {
  server: PlaybackServer;
  tmdbId: number;
  type: 'movie' | 'tv';
  season?: number;
  episode?: number;
  title?: string;
  imdbId?: string | null;
}

export interface ResolvedStream {
  videoUrl: string;
  isWebM: boolean;
}

export type Resolver = (req: ResolveRequest) => Promise<ResolvedStream>;

export interface EnqueueOptions {
  server: PlaybackServer;
  qualityHeight: number;
  qualityLabel: string;
  season?: number;
  episode?: number;
  title: string;
  streamUri?: string;
  kind?: 'hls' | 'file';
  subtitleLanguage?: string;
  imdbId?: string | null;
  headers?: Record<string, string>;
  serverName?: string;
}

// ---------------------------------------------------------------------------
// Constants / helpers
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'flick.downloads.desktop';

const TAG = '[DownloadService:web]';
// eslint-disable-next-line no-console
const log = (...args: unknown[]) => console.log(TAG, ...args);

const inferKind = (url: string): 'hls' | 'file' =>
  /\.m3u8/i.test(url) || /[?&]type=m3u8\b/i.test(url) ? 'hls' : 'file';

const jobIdFor = (
  item: MediaItem,
  season: number | undefined,
  episode: number | undefined,
  qualityHeight: number,
): string => {
  const media = item.media_type ?? 'movie';
  const suffix =
    season != null && episode != null ? `-s${season}e${episode}` : '';
  return `${media}-${item.id}${suffix}-q${qualityHeight}`;
};

const buildHeaders = (
  serverUrl: string,
  resolver?: ServerResolver,
): Record<string, string> =>
  resolver === 'streamflix'
    ? { ...STREAMFLIX_PLAYBACK_HEADERS }
    : resolver === 'flixquest'
      ? {}
      : {
          Referer: `${serverUrl}/`,
          Origin: originOf(serverUrl),
        };

const bridge = () =>
  typeof window !== 'undefined' ? window.coffeDesktop : undefined;

/** Origin of the loopback server that serves the exported bundle + media. */
const mediaOrigin = (): string => {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  return '';
};

const mediaFolderUrl = (folder: string): string =>
  `${mediaOrigin()}/__media/${encodeURIComponent(folder)}`;

const mediaFileUrl = (folder: string, file: string): string =>
  `${mediaFolderUrl(folder)}/${encodeURIComponent(file)}`;

type Listener = (jobs: DownloadJob[]) => void;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class DownloadServiceImpl {
  private jobs = new Map<string, DownloadJob>();
  private listeners = new Set<Listener>();
  private resolver: Resolver | null = null;
  private hydrated = false;
  private progressBound = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  // -------------------------------------------------------------------------
  // Bootstrap / persistence
  // -------------------------------------------------------------------------

  async hydrate(): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true;

    this.bindProgress();

    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as DownloadJob[];
        for (const job of parsed) {
          // A job that was mid-flight when the app closed keeps its partial
          // files on disk; it is surfaced as paused and resumed from where it
          // stopped (HLS skips finished segments, direct files use `.part`).
          if (
            job.status === 'downloading' ||
            job.status === 'resolving' ||
            job.status === 'queued'
          ) {
            job.status = 'paused';
          }
          this.jobs.set(job.id, job);
        }
      }
    } catch (e) {
      log('hydrate failed', e);
    }

    this.emit();
  }

  private bindProgress(): void {
    if (this.progressBound) return;
    const desktop = bridge();
    if (!desktop?.onDownloadProgress) return;
    this.progressBound = true;

    desktop.onDownloadProgress((progress) => {
      const job = this.jobs.get(progress.id);
      if (!job) return;

      if (progress.status === 'downloading') {
        this.updateJob(progress.id, {
          status: 'downloading',
          bytesWritten: progress.received ?? job.bytesWritten,
          totalBytes: progress.total ?? job.totalBytes,
          completedSegments:
            progress.completedSegments ?? job.completedSegments,
          totalSegments: progress.totalSegments ?? job.totalSegments,
          error: undefined,
        });
        return;
      }

      if (progress.status === 'completed') {
        const folder = progress.folder || job.id;
        const file = progress.file || 'index.m3u8';
        const kind = progress.kind ?? job.kind;
        this.updateJob(progress.id, {
          status: 'completed',
          kind,
          localDir: mediaFolderUrl(folder),
          localUri: mediaFileUrl(folder, file),
          bytesWritten: progress.received ?? job.bytesWritten,
          totalBytes: progress.total ?? job.totalBytes,
          completedSegments:
            progress.completedSegments ?? job.completedSegments,
          totalSegments: progress.totalSegments ?? job.totalSegments,
          error: undefined,
        });
        // Captions are optional: the video is already playable offline, so a
        // failed/slow Wyzie lookup must never change the job status.
        void this.bundleSubtitle(progress.id);
        return;
      }

      if (progress.status === 'cancelled') {
        // Pause already set the status; a cancel event for a job that is
        // still shown as downloading means the user cancelled it outright.
        if (job.status === 'downloading') {
          this.updateJob(progress.id, { status: 'paused' });
        }
        return;
      }

      this.updateJob(progress.id, {
        status: 'failed',
        error: progress.error || 'Download failed',
      });
    });
  }

  setResolver(resolver: Resolver | null): void {
    this.resolver = resolver;
  }

  /**
   * Run the currently-registered resolver directly. Used by the detail screen
   * to peek at the stream URL so it can fetch HLS variants for the quality
   * sheet before enqueueing a job.
   */
  async resolveStream(req: ResolveRequest): Promise<ResolvedStream> {
    if (!this.resolver) throw new Error('Resolver not ready');
    return this.resolver(req);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): DownloadJob[] {
    return Array.from(this.jobs.values()).sort(
      (a, b) => b.createdAt - a.createdAt,
    );
  }

  getJob(id: string): DownloadJob | undefined {
    return this.jobs.get(id);
  }

  getJobFor(
    item: Pick<MediaItem, 'id' | 'media_type'>,
    season?: number,
    episode?: number,
  ): DownloadJob | undefined {
    const media = item.media_type ?? 'movie';
    return Array.from(this.jobs.values()).find(
      (j) =>
        (j.item.media_type ?? 'movie') === media &&
        j.item.id === item.id &&
        j.season === season &&
        j.episode === episode,
    );
  }

  getLocalSource(id: string): ReactVideoSource | null {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'completed' || !job.localUri) return null;
    return {
      uri: job.localUri,
      isNetwork: false,
      type: job.kind === 'hls' ? 'm3u8' : undefined,
      textTracksAllowChunklessPreparation: false,
    };
  }

  /**
   * The shell's loopback server already serves the rewritten playlist and its
   * segments over HTTP with `Range` support, so no extra preparation is
   * needed (unlike iOS, which needs a loopback server of its own).
   */
  async prepareLocalPlayback(id: string): Promise<ReactVideoSource | null> {
    const base = this.getLocalSource(id);
    if (!base) return null;
    return {
      ...base,
      textTracksAllowChunklessPreparation: false,
    };
  }

  async stopLocalPlayback(): Promise<void> {
    /* nothing to stop — the HTTP server is owned by the shell */
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async enqueue(item: MediaItem, opts: EnqueueOptions): Promise<DownloadJob> {
    await this.hydrate();

    const id = jobIdFor(item, opts.season, opts.episode, opts.qualityHeight);
    const kind =
      opts.kind ?? (opts.streamUri ? inferKind(opts.streamUri) : 'hls');

    const existing = this.jobs.get(id);
    if (existing) {
      if (
        existing.status === 'queued' ||
        existing.status === 'paused' ||
        existing.status === 'failed'
      ) {
        const streamUri = opts.streamUri ?? existing.streamUri;
        // Only keep partial files when the stream URL is unchanged; a new
        // URL may use different segment names/keys.
        const canResume = !!existing.streamUri && existing.streamUri === streamUri;
        this.updateJob(id, {
          streamUri,
          kind,
          headers: opts.headers ?? existing.headers,
          serverName: opts.serverName ?? existing.serverName,
          server: opts.server,
          serverId: opts.server.id,
          subtitleLanguage:
            opts.subtitleLanguage?.trim() || existing.subtitleLanguage,
          error: undefined,
          status: 'queued',
        });
        void this.start(id, streamUri, kind, canResume).catch((e) =>
          log('start failed for', id, e),
        );
        return this.jobs.get(id)!;
      }
      return existing;
    }

    const now = Date.now();
    const job: DownloadJob = {
      id,
      item,
      season: opts.season,
      episode: opts.episode,
      title: opts.title,
      qualityHeight: opts.qualityHeight,
      qualityLabel: opts.qualityLabel,
      status: 'queued',
      kind,
      streamUri: opts.streamUri,
      totalSegments: 0,
      completedSegments: 0,
      completedSegmentIndices: [],
      bytesWritten: 0,
      totalBytes: 0,
      localDir: mediaFolderUrl(id),
      subtitleLanguage: opts.subtitleLanguage?.trim() || undefined,
      headers:
        opts.headers ?? buildHeaders(opts.server.url, opts.server.resolver),
      serverId: opts.server.id,
      serverName: opts.serverName ?? opts.server.name,
      server: opts.server,
      imdbId: opts.imdbId,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(id, job);
    this.persist();
    this.emit();

    void this.start(id, opts.streamUri, kind, false).catch((e) =>
      log('start failed for', id, e),
    );

    return job;
  }

  async pause(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    if (job.status !== 'downloading' && job.status !== 'resolving') return;
    this.updateJob(id, { status: 'paused' });
    await bridge()?.downloadCancel(id);
  }

  async resume(id: string, server?: PlaybackServer): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    if (
      job.status !== 'paused' &&
      job.status !== 'failed' &&
      job.status !== 'queued'
    ) {
      return;
    }

    if (server) {
      this.updateJob(id, {
        server,
        serverId: server.id,
        serverName: server.name,
        headers: buildHeaders(server.url, server.resolver),
      });
    }
    this.updateJob(id, { status: 'queued', error: undefined });

    const latest = this.jobs.get(id) ?? job;
    // Resume keeps the segments/`.part` bytes already on disk instead of
    // re-downloading the whole stream.
    void this.start(latest.id, latest.streamUri, latest.kind, true).catch((e) =>
      log('resume failed for', id, e),
    );
  }

  async cancel(id: string): Promise<void> {
    await this.remove(id);
  }

  async remove(id: string): Promise<void> {
    const job = this.jobs.get(id);
    const desktop = bridge();
    if (desktop) {
      await desktop.downloadCancel(id).catch(() => false);
      // Give the aborted writer a moment to release its file handle before
      // Windows refuses to delete the folder.
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      await desktop.downloadRemove(job ? folderOf(job) : id).catch(() => false);
    }
    this.jobs.delete(id);
    this.persist();
    this.emit();
  }

  async clearCompleted(): Promise<void> {
    const completed = [...this.jobs.values()].filter(
      (j) => j.status === 'completed',
    );
    for (const job of completed) {
      await this.remove(job.id);
    }
  }

  // -------------------------------------------------------------------------
  // Shell bridge
  // -------------------------------------------------------------------------

  private async start(
    id: string,
    streamUri: string | undefined,
    kind: 'hls' | 'file',
    resume = false,
  ): Promise<void> {
    const desktop = bridge();
    if (!desktop) {
      this.updateJob(id, {
        status: 'failed',
        error: 'Downloads are only available in the desktop app.',
      });
      return;
    }

    let url = streamUri;
    if (!url) {
      const job = this.jobs.get(id);
      if (!job) return;
      if (!this.resolver) {
        this.updateJob(id, {
          status: 'failed',
          error:
            'DownloadService has no resolver. Mount <DownloadResolverHost /> at the app root.',
        });
        return;
      }
      this.updateJob(id, { status: 'resolving' });
      const resolved = await this.resolver({
        server: job.server ?? {
          id: job.serverId ?? '',
          name: job.serverName ?? '',
          url: '',
        },
        tmdbId: job.item.id,
        type: (job.item.media_type ?? 'movie') === 'tv' ? 'tv' : 'movie',
        season: job.season,
        episode: job.episode,
        title: job.title,
        imdbId: job.imdbId,
      });
      url = resolved.videoUrl;
      this.updateJob(id, {
        streamUri: url,
        kind: resolved.isWebM ? 'file' : kind,
      });
    }

    const job = this.jobs.get(id);
    if (!job) return;

    const result = await desktop.downloadStart({
      id,
      url,
      folder: id,
      headers: job.headers,
      kind,
      resume,
    });

    if (!result?.ok) {
      this.updateJob(id, {
        status: 'failed',
        error: result?.error || 'Could not start the download.',
      });
      return;
    }

    this.updateJob(id, { status: 'downloading', error: undefined });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Writes the preferred-language WebVTT sidecar next to a completed download
   * so captions keep working with the network off. Soft-fails on purpose: the
   * video is already playable, and the player just shows no offline tracks.
   */
  private async bundleSubtitle(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'completed') return;
    const desktop = bridge();
    if (!desktop?.saveSubtitle) return;

    const language = job.subtitleLanguage?.trim();
    if (!language || job.subtitles?.length) return;

    try {
      // Same catalog pair the online player uses: Vdrk is keyless, Wyzie adds
      // the language-filtered extras. Both return WebVTT.
      const [wyzie, vdrk] = await Promise.allSettled([
        WyzieService.searchSubtitles({
          tmdbId: job.item.id,
          season: job.season,
          episode: job.episode,
          language,
          format: 'vtt',
        }),
        VdrkSubtitleService.searchSubtitles({
          tmdbId: job.item.id,
          season: job.season,
          episode: job.episode,
        }),
      ]);
      const tracks = [
        ...(vdrk.status === 'fulfilled' ? vdrk.value : []),
        ...(wyzie.status === 'fulfilled' ? wyzie.value : []),
      ];
      if (!tracks.length) {
        log('no subtitle tracks for', id, language);
        return;
      }
      const track =
        tracks.find((t) => t.language === language && !t.isHearingImpaired) ??
        tracks.find((t) => t.language === language) ??
        tracks.find((t) => !t.isHearingImpaired) ??
        tracks[0];

      const text = await WyzieService.fetchSubtitleText(track.url);
      if (!text.trim()) return;

      const folder = folderOf(job);
      const saved = await desktop.saveSubtitle({ folder, language, text });
      if (!saved?.ok || !saved.file) {
        log('subtitle save failed for', id, saved?.error);
        return;
      }

      this.updateJob(id, {
        subtitles: [
          {
            id: track.id,
            language: track.language || language,
            display: track.display,
            localUri: mediaFileUrl(folder, saved.file),
            isHearingImpaired: track.isHearingImpaired,
          },
        ],
      });
      log('wrote offline subtitle', id, saved.file);
    } catch (e) {
      log('subtitle bundling soft-failed for', id, e);
    }
  }

  private updateJob(id: string, patch: Partial<DownloadJob>): void {
    const current = this.jobs.get(id);
    if (!current) return;
    this.jobs.set(id, { ...current, ...patch, updatedAt: Date.now() });
    this.persist();
    this.emit();
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const listener of this.listeners) listener(snap);
  }

  private persist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(Array.from(this.jobs.values())),
      ).catch((e) => log('persist failed', e));
    }, 400);
  }
}

/** `<job id>` is the folder name; recover it from the served URL. */
const folderOf = (job: DownloadJob): string => {
  const match = /\/__media\/([^/]+)/.exec(job.localDir || '');
  if (match) return decodeURIComponent(match[1]);
  return job.id;
};

export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
};

export const DownloadService = new DownloadServiceImpl();

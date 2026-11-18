import Hls from 'hls.js';
import {
  createElement,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { ReactVideoProps, VideoRef } from 'react-native-video';

/**
 * Web / Windows player.
 *
 * We deliberately do NOT use `react-native-video`'s web build here: it wraps
 * the element with `unstable_createElement` from react-native-web, which was
 * removed in react-native-web 0.21. Rendering it throws and React unmounts
 * the whole tree (a black window). Instead this component owns a plain
 * `<video>` element and implements the small slice of the `VideoRef` surface
 * the app actually uses.
 *
 * Chromium has no native HLS, and every stream the scraper finds is an
 * `.m3u8`, so HLS is handed to hls.js. Desktop only: when Chromium cannot
 * play a source (MKV, HEVC, AC3/DTS) or an origin rejects the request
 * (missing Referer/cookies), the component escalates to the shell's FFmpeg
 * compatibility engine (`window.coffeDesktop.preparePlayback`) and swaps in
 * the URL it returns - a header-aware HLS proxy, a live HLS relay, or a
 * converted local MP4 - without leaving the player.
 */

type Override = { uri: string; hls: boolean } | null;

type Preparing = { percent: number | null; label: string };

const isHlsUri = (uri: string, type?: string): boolean => {
  if (!uri) return false;
  if (type === 'm3u8') return true;
  return /\.m3u8(\?|$)/i.test(uri) || /[?&]type=m3u8\b/i.test(uri);
};

/** Absolute URL for the bridge (the shell rejects relative ones). */
const absolutize = (uri: string): string => {
  try {
    return new URL(uri, window.location.origin).toString();
  } catch {
    return uri;
  }
};

const isCompatUrl = (uri: string): boolean =>
  /\/(?:__hls|__relay|__compat)\//.test(uri);

/** RN `resizeMode` -> CSS `object-fit`. */
const OBJECT_FIT: Record<string, CSSProperties['objectFit']> = {
  contain: 'contain',
  cover: 'cover',
  stretch: 'fill',
  none: 'none',
};

const HlsVideo = forwardRef<VideoRef, ReactVideoProps>((props, ref) => {
  const elementRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);

  /** Escalation result (compat proxy / relay / converted file). */
  const [override, setOverride] = useState<Override>(null);
  /** Proactive header proxy result for the original URL. */
  const [proxied, setProxied] = useState<Override>(null);
  const [failed, setFailed] = useState(false);
  const [preparing, setPreparing] = useState<Preparing | null>(null);

  const mountedRef = useRef(true);
  const attemptsRef = useRef(0);
  const propsRef = useRef(props);
  propsRef.current = props;

  const originalUri =
    typeof props.source?.uri === 'string' ? props.source.uri : '';
  const headers = props.source?.headers as Record<string, string> | undefined;
  const headersRef = useRef(headers);
  headersRef.current = headers;
  // Cheap identity for the headers object: the caller rebuilds it on every
  // render, so comparing by reference would re-run the proxy effect forever.
  const headersKey = headers ? JSON.stringify(headers) : '';
  const originalHls = isHlsUri(originalUri, props.source?.type);

  const effective = override ?? proxied;
  const uri = effective?.uri ?? originalUri;
  const hls = effective ? effective.hls : originalHls;

  const uriRef = useRef(uri);
  uriRef.current = uri;
  const originalRef = useRef(originalUri);
  originalRef.current = originalUri;

  const failWith = useCallback((detail: string) => {
    setPreparing(null);
    setFailed(true);
    propsRef.current.onError?.({ error: { errorString: detail, code: 0 } });
  }, []);

  /**
   * Ask the shell for a playable variant of the current URL. Returns `true`
   * when an override was installed, so the caller can skip its own error UI.
   */
  const escalate = useCallback(
    async (mode: 'proxy' | 'relay'): Promise<boolean> => {
      const desktop =
        typeof window !== 'undefined' ? window.coffeDesktop : undefined;
      if (!desktop?.preparePlayback) return false;

      const current = uriRef.current;
      if (!current) return false;
      // Never escalate a URL the shell itself produced - that would recurse.
      if (isCompatUrl(current)) return false;
      if (attemptsRef.current >= 2) return false;
      attemptsRef.current += 1;

      setPreparing({
        percent: null,
        label:
          mode === 'proxy'
            ? 'Connecting through the compatibility proxy.'
            : 'Preparing compatible playback.',
      });

      try {
        const result = await desktop.preparePlayback({
          url: absolutize(current),
          headers: headersRef.current,
          mode,
        });
        if (!mountedRef.current) return false;
        if (!result?.ok || !result.url) {
          setPreparing(null);
          return false;
        }
        if (result.url === current) {
          // Already playable - no point swapping the source.
          setPreparing(null);
          return false;
        }
        setPreparing(null);
        setFailed(false);
        setOverride({ uri: result.url, hls: result.kind === 'hls' });
        return true;
      } catch {
        if (mountedRef.current) setPreparing(null);
        return false;
      }
    },
    [],
  );

  // A new source is a fresh start: forget the previous overrides/attempts so
  // switching episodes can escalate again.
  useEffect(() => {
    attemptsRef.current = 0;
    setOverride(null);
    setProxied(null);
    setFailed(false);
    setPreparing(null);
  }, [originalUri]);

  /**
   * Streams carry a Referer/Origin requirement, and a bare `<video>` cannot
   * send custom headers. Route header-bearing HLS through the shell's
   * header-aware proxy up front; if that fails the element tries the origin
   * directly and the error path escalates to a transcode.
   */
  useEffect(() => {
    const desktop = window.coffeDesktop;
    if (!desktop?.preparePlayback) return;
    if (!originalUri || !originalHls || !headersKey) return;
    if (isCompatUrl(originalUri)) return;

    let cancelled = false;
    void desktop
      .preparePlayback({
        url: absolutize(originalUri),
        headers: headersRef.current,
        mode: 'proxy',
      })
      .then((result) => {
        if (cancelled || !mountedRef.current) return;
        if (!result?.ok || !result.url) return;
        if (result.url === originalUri) return;
        setProxied({ uri: result.url, hls: result.kind === 'hls' });
      })
      .catch(() => {
        /* fall back to the direct URL */
      });

    return () => {
      cancelled = true;
    };
  }, [originalUri, originalHls, headersKey]);

  // Conversion/relay progress from the shell. Only the source this instance is
  // currently trying to fix matters.
  useEffect(() => {
    const subscribe = window.coffeDesktop?.onCompatProgress;
    if (!subscribe) return;
    return subscribe((progress) => {
      if (!mountedRef.current) return;
      if (
        progress.source !== originalRef.current &&
        progress.source !== uriRef.current
      ) {
        return;
      }
      if (progress.phase === 'error') {
        setPreparing(null);
        return;
      }
      setPreparing({
        percent: typeof progress.percent === 'number' ? progress.percent : null,
        label: progress.message || 'Preparing compatible playback.',
      });
    });
  }, []);

  // Stop a conversion that is still running when the player goes away.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const desktop = window.coffeDesktop;
      if (desktop?.compatCancel) void desktop.compatCancel(originalRef.current);
    };
  }, []);

  const handleElementError = useCallback(() => {
    if (hlsRef.current) return;
    void escalate('relay').then((switched) => {
      if (switched) return;
      const error = elementRef.current?.error;
      propsRef.current.onError?.({
        error: {
          errorString: error?.message || 'Playback failed',
          code: error?.code ?? 0,
        },
      });
    });
  }, [escalate]);

  // Load / unload the media element whenever the (possibly overridden) URL
  // changes.
  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    propsRef.current.onLoadStart?.({
      isNetwork: true,
      type: 'unknown',
      uri,
    });

    if (!uri) {
      element.removeAttribute('src');
      element.load();
      return;
    }

    if (hls) {
      element.removeAttribute('src');

      // Safari (and any browser with native HLS) needs no help.
      if (element.canPlayType('application/vnd.apple.mpegurl')) {
        element.src = uri;
        return;
      }
      if (!Hls.isSupported()) {
        failWith('HLS is not supported by this browser');
        return;
      }

      setFailed(false);
      const instance = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 90,
        manifestLoadingTimeOut: 20000,
        fragLoadingTimeOut: 45000,
      });
      hlsRef.current = instance;

      let networkRetries = 0;
      let mediaRecovered = false;

      instance.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;

        // Transient network/media faults are recoverable once; after that the
        // compatibility engine gets a chance (headers proxy, then transcode).
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          networkRetries += 1;
          if (networkRetries <= 1) {
            instance.startLoad();
            return;
          }
          void escalate('proxy').then((switched) => {
            if (!switched) failWith(data.details || 'HLS network error');
          });
          return;
        }

        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          if (!mediaRecovered) {
            mediaRecovered = true;
            instance.recoverMediaError();
            return;
          }
          void escalate('relay').then((switched) => {
            if (!switched) failWith(data.details || 'HLS media error');
          });
          return;
        }

        void escalate('relay').then((switched) => {
          if (!switched) failWith(data.details || 'HLS playback failed');
        });
      });

      instance.on(Hls.Events.MANIFEST_PARSED, () => {
        if (!propsRef.current.paused) {
          element.play().catch(() => {
            /* autoplay can be denied; the user can press play */
          });
        }
      });

      instance.loadSource(uri);
      instance.attachMedia(element);

      return () => {
        instance.destroy();
        if (hlsRef.current === instance) hlsRef.current = null;
      };
    }

    setFailed(false);
    element.src = uri;
    return () => {
      element.removeAttribute('src');
      element.load();
    };
  }, [uri, hls, escalate, failWith]);

  // Keep play/pause in sync.
  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    if (props.paused) element.pause();
    else element.play().catch(() => {});
  }, [props.paused, uri]);

  // Volume / rate / loop / mute.
  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const volume = props.volume;
    if (typeof volume === 'number' && Number.isFinite(volume)) {
      element.volume = Math.max(0, Math.min(1, volume));
    }
    if (typeof props.muted === 'boolean') element.muted = props.muted;
    if (props.repeat != null) element.loop = !!props.repeat;
    const rate = props.rate;
    if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) {
      element.playbackRate = rate;
    }
  }, [props.volume, props.muted, props.repeat, props.rate, uri]);

  // Picture-in-picture status, mirroring the native event name.
  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const notify = (isActive: boolean) => () =>
      propsRef.current.onPictureInPictureStatusChanged?.({ isActive });
    const enter = notify(true);
    const leave = notify(false);
    element.addEventListener('enterpictureinpicture', enter);
    element.addEventListener('leavepictureinpicture', leave);
    return () => {
      element.removeEventListener('enterpictureinpicture', enter);
      element.removeEventListener('leavepictureinpicture', leave);
    };
  }, []);

  // Honour the quality picker: map the app's `selectedVideoTrack` onto an
  // hls.js level so "1080p" means 1080p instead of whatever ABR chose.
  useEffect(() => {
    const instance = hlsRef.current;
    if (!instance) return;
    const selected = props.selectedVideoTrack as
      | { type?: string; value?: unknown }
      | undefined;
    if (!selected) return;

    if (selected.type === 'auto') {
      instance.currentLevel = -1;
      return;
    }
    if (selected.type === 'index') {
      const index = Number(selected.value);
      if (Number.isFinite(index) && index >= 0) instance.currentLevel = index;
      return;
    }
    if (selected.type === 'resolution') {
      const target = Number(selected.value);
      if (!Number.isFinite(target) || !instance.levels?.length) return;
      let best = -1;
      let bestDelta = Infinity;
      instance.levels.forEach((level, index) => {
        const delta = Math.abs((level.height || 0) - target);
        if (delta < bestDelta) {
          bestDelta = delta;
          best = index;
        }
      });
      if (best >= 0) instance.currentLevel = best;
    }
  }, [props.selectedVideoTrack, uri]);

  useImperativeHandle(
    ref,
    () =>
      ({
        seek: (seconds: number) => {
          const element = elementRef.current;
          if (!element) return;
          try {
            element.currentTime = Math.max(0, Number(seconds) || 0);
          } catch {
            /* metadata not ready yet */
          }
        },
        getCurrentPosition: async () =>
          elementRef.current?.currentTime ?? 0,
        setSource: (source: { uri?: string; type?: string } | null) => {
          const next = source?.uri;
          if (!next) return;
          setOverride({ uri: next, hls: isHlsUri(next, source?.type) });
        },
        pause: () => elementRef.current?.pause(),
        resume: () => {
          elementRef.current?.play().catch(() => {});
        },
        setVolume: (volume: number) => {
          const element = elementRef.current;
          if (element) element.volume = Math.max(0, Math.min(1, volume));
        },
        presentFullscreenPlayer: () => {
          void elementRef.current?.requestFullscreen?.();
        },
        dismissFullscreenPlayer: () => {
          if (document.fullscreenElement) void document.exitFullscreen();
        },
        setFullScreen: (value: boolean) => {
          if (value) void elementRef.current?.requestFullscreen?.();
          else if (document.fullscreenElement) void document.exitFullscreen();
        },
        enterPictureInPicture: () => {
          const element = elementRef.current as
            | (HTMLVideoElement & { requestPictureInPicture?: () => Promise<unknown> })
            | null;
          void element?.requestPictureInPicture?.();
        },
        exitPictureInPicture: () => {
          if (document.pictureInPictureElement) {
            void document.exitPictureInPicture();
          }
        },
        nativeHtmlVideoRef: elementRef,
      }) as unknown as VideoRef,
    [],
  );

  const objectFit =
    OBJECT_FIT[String(props.resizeMode ?? 'contain')] ?? 'contain';

  const videoStyle: CSSProperties = {
    width: '100%',
    height: '100%',
    display: 'block',
    objectFit,
    backgroundColor: '#000',
  };

  const overlay = preparing ? (
    <View style={styles.overlay} pointerEvents="none">
      <View style={styles.card}>
        <Text style={styles.title}>Preparing playback</Text>
        <Text style={styles.detail}>
          {preparing.label}
          {preparing.percent != null ? ` ${Math.round(preparing.percent)}%` : ''}
        </Text>
        {preparing.percent != null && (
          <View style={styles.track}>
            <View
              style={[
                styles.fill,
                {
                  width: `${Math.max(0, Math.min(100, preparing.percent))}%`,
                },
              ]}
            />
          </View>
        )}
      </View>
    </View>
  ) : null;

  return (
    <View style={[styles.container, props.style]} pointerEvents="none">
      {createElement('video', {
        ref: elementRef,
        style: videoStyle,
        playsInline: true,
        preload: 'auto',
        controls: false,
        onLoadedMetadata: () => {
          const element = elementRef.current;
          if (!element) return;
          const duration = Number.isFinite(element.duration)
            ? element.duration
            : 0;
          propsRef.current.onLoad?.({
            currentTime: element.currentTime,
            duration,
            naturalSize: {
              width: element.videoWidth,
              height: element.videoHeight,
              orientation:
                element.videoWidth >= element.videoHeight
                  ? 'landscape'
                  : 'portrait',
            },
            videoTracks: [],
            textTracks: [],
            audioTracks: [],
          } as never);
        },
        onTimeUpdate: () => {
          const element = elementRef.current;
          if (!element) return;
          const buffered = element.buffered.length
            ? element.buffered.end(element.buffered.length - 1)
            : 0;
          propsRef.current.onProgress?.({
            currentTime: element.currentTime,
            playableDuration: buffered,
            seekableDuration: buffered,
          } as never);
        },
        onEnded: () => propsRef.current.onEnd?.(),
        onWaiting: () => propsRef.current.onBuffer?.({ isBuffering: true }),
        onPlaying: () => propsRef.current.onBuffer?.({ isBuffering: false }),
        onCanPlay: () => propsRef.current.onBuffer?.({ isBuffering: false }),
        onError: handleElementError,
      })}
      {overlay}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
  },
  card: {
    minWidth: 260,
    maxWidth: 420,
    paddingHorizontal: 22,
    paddingVertical: 18,
    borderRadius: 14,
    backgroundColor: 'rgba(20, 16, 12, 0.92)',
    alignItems: 'center',
  },
  title: {
    color: '#f5e9dc',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 6,
  },
  detail: {
    color: '#c9b8a6',
    fontSize: 13,
    textAlign: 'center',
  },
  track: {
    marginTop: 4,
    width: '100%',
    height: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: 3,
    backgroundColor: '#E50914',
  },
});

HlsVideo.displayName = 'VideoPlayer';

export default HlsVideo;

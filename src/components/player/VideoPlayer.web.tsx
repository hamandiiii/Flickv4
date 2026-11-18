import Hls from 'hls.js';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Video, {
  SelectedVideoTrackType,
  type ReactVideoProps,
  type VideoRef,
} from 'react-native-video';

/**
 * Web / Windows player.
 *
 * `react-native-video`'s web implementation is a plain `<video>` element, and
 * Chromium has no native HLS support — but every stream the scraper finds is
 * an `.m3u8`. So for HLS sources we hand the URL to `hls.js`, attach it to the
 * same `<video>` element the library renders (exposed as
 * `VideoRef.nativeHtmlVideoRef`), and blank out the element's own `src` so the
 * two players do not fight over it.
 *
 * Everything else (MP4/WebM, seeking, PiP, captions handled by the app) is
 * delegated unchanged.
 *
 * Desktop only: when Chromium cannot play a source (MKV container, HEVC video,
 * AC3/DTS audio) or an origin rejects the request (missing Referer/cookies),
 * the component escalates to the shell's FFmpeg compatibility engine
 * (`window.coffeDesktop.preparePlayback`) and swaps in the URL it returns —
 * a header-aware HLS proxy, a live HLS relay, or a converted local MP4 —
 * without leaving the player.
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

const HlsVideo = forwardRef<VideoRef, ReactVideoProps>((props, ref) => {
  const innerRef = useRef<VideoRef | null>(null);
  const hlsRef = useRef<Hls | null>(null);

  const [override, setOverride] = useState<Override>(null);
  const [failed, setFailed] = useState(false);
  const [preparing, setPreparing] = useState<Preparing | null>(null);

  const mountedRef = useRef(true);
  const attemptsRef = useRef(0);
  const propsRef = useRef(props);
  propsRef.current = props;

  // Expose the underlying react-native-video handle unchanged (seek,
  // setSource, PiP, ...). No dependency list: the child ref is attached during
  // the same commit, so the first layout-effect pass captures the real object.
  useImperativeHandle(ref, () => innerRef.current as VideoRef);

  const originalUri = typeof props.source?.uri === 'string' ? props.source.uri : '';
  const headers = props.source?.headers;
  const originalHls = isHlsUri(originalUri, props.source?.type);

  // `headers` is rebuilt by the caller on every render, so keep it in a ref:
  // putting it in the `escalate` dependency list would destroy/recreate the
  // hls.js instance on every progress tick.
  const headersRef = useRef(headers);
  headersRef.current = headers;

  const effectiveUri = override?.uri ?? originalUri;
  const effectiveHls = override ? override.hls : originalHls;

  const uriRef = useRef(effectiveUri);
  uriRef.current = effectiveUri;
  const originalRef = useRef(originalUri);
  originalRef.current = originalUri;
  const effectiveHlsRef = useRef(effectiveHls);
  effectiveHlsRef.current = effectiveHls;

  const failWith = useCallback((detail: string) => {
    setPreparing(null);
    setFailed(true);
    propsRef.current.onError?.({
      error: { errorString: detail, code: 0 },
    });
  }, []);

  /**
   * Ask the shell for a playable variant of the current URL. Returns `true`
   * when an override was installed, so the caller can skip its own error UI.
   */
  const escalate = useCallback(async (mode: 'proxy' | 'relay'): Promise<boolean> => {
    const desktop = typeof window !== 'undefined' ? window.coffeDesktop : undefined;
    if (!desktop?.preparePlayback) return false;

    const current = uriRef.current;
    if (!current) return false;
    // Never escalate a URL the shell itself produced — that would recurse.
    if (isCompatUrl(current)) return false;
    if (attemptsRef.current >= 2) return false;
    attemptsRef.current += 1;

    setPreparing({
      percent: null,
      label:
        mode === 'proxy'
          ? 'Connecting through the compatibility proxy…'
          : 'Preparing compatible playback…',
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
        // Already playable — no point swapping the source.
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
  }, []);

  // A new source is a fresh start: forget the previous overrides/attempts so
  // switching episodes can escalate again.
  useEffect(() => {
    attemptsRef.current = 0;
    setOverride(null);
    setFailed(false);
    setPreparing(null);
  }, [originalUri]);

  // Conversion/relay progress from the shell. Only the source this instance is
  // currently trying to fix matters.
  useEffect(() => {
    const subscribe = window.coffeDesktop?.onCompatProgress;
    if (!subscribe) return;
    return subscribe((progress) => {
      if (!mountedRef.current) return;
      if (progress.source !== originalRef.current && progress.source !== uriRef.current) {
        return;
      }
      if (progress.phase === 'error') {
        setPreparing(null);
        return;
      }
      setPreparing({
        percent:
          typeof progress.percent === 'number' ? progress.percent : null,
        label: progress.message || 'Preparing compatible playback…',
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

  // Create/destroy the hls.js instance when the (possibly overridden) URL
  // changes.
  useEffect(() => {
    if (!effectiveHls || !effectiveUri) return;

    const element = innerRef.current?.nativeHtmlVideoRef?.current;
    if (!element) return;

    // Safari (and any browser with native HLS) needs no help.
    if (element.canPlayType('application/vnd.apple.mpegurl')) return;
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

    instance.loadSource(effectiveUri);
    instance.attachMedia(element);

    instance.on(Hls.Events.MANIFEST_PARSED, () => {
      if (!propsRef.current.paused) {
        element.play().catch(() => {
          /* autoplay can be denied; the user can press play */
        });
      }
    });

    return () => {
      instance.destroy();
      if (hlsRef.current === instance) hlsRef.current = null;
    };
    // `props` intentionally omitted: only the URL identity matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveHls, effectiveUri, escalate, failWith]);

  // Keep play/pause in sync once hls.js owns the element.
  useEffect(() => {
    if (!hlsRef.current) return;
    const element = innerRef.current?.nativeHtmlVideoRef?.current;
    if (!element) return;
    if (props.paused) element.pause();
    else element.play().catch(() => {});
  }, [props.paused]);

  // Honour the quality picker: map the app's `selectedVideoTrack` onto an
  // hls.js level so "1080p" means 1080p instead of whatever ABR chose.
  useEffect(() => {
    const instance = hlsRef.current;
    if (!instance) return;
    const selected = props.selectedVideoTrack;
    if (!selected) return;

    if (selected.type === SelectedVideoTrackType.AUTO) {
      instance.currentLevel = -1;
      return;
    }
    if (selected.type === SelectedVideoTrackType.DISABLED) {
      // Video cannot be disabled, but audio-only is not a product state;
      // leave ABR alone rather than freezing the picture.
      return;
    }
    if (selected.type === SelectedVideoTrackType.INDEX) {
      const index = Number(selected.value);
      if (Number.isFinite(index) && index >= 0) instance.currentLevel = index;
      return;
    }
    if (selected.type === SelectedVideoTrackType.RESOLUTION) {
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
  }, [props.selectedVideoTrack, effectiveUri]);

  /**
   * `<video>` element failure (the non-HLS path, e.g. a downloaded MKV).
   * hls.js reports its own errors, so element errors are ignored while it
   * owns the media element.
   */
  const handleElementError = useCallback(
    (event: Parameters<NonNullable<ReactVideoProps['onError']>>[0]) => {
      if (effectiveHlsRef.current) return;
      void escalate('relay').then((switched) => {
        if (!switched) propsRef.current.onError?.(event);
      });
    },
    [escalate],
  );

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
                { width: `${Math.max(0, Math.min(100, preparing.percent))}%` },
              ]}
            />
          </View>
        )}
      </View>
    </View>
  ) : null;

  if (failed) {
    // `failWith` already reported the error to the app, so keep the element
    // silent (no src, no duplicate `onError`) instead of a black rectangle.
    return (
      <>
        <Video
          {...props}
          ref={innerRef}
          source={{ ...props.source, uri: undefined }}
          onError={undefined}
        />
        {overlay}
      </>
    );
  }

  return (
    <>
      <Video
        {...props}
        ref={innerRef}
        source={effectiveHls ? { ...props.source, uri: undefined } : { ...props.source, uri: effectiveUri }}
        onError={handleElementError}
      />
      {overlay}
    </>
  );
});

const styles = StyleSheet.create({
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
    marginTop: 12,
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

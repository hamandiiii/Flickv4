import Hls from 'hls.js';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
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
 * delegated unchanged, which keeps the desktop player behaviourally identical
 * to the browser build apart from the added HLS support.
 */

const isHlsSource = (props: ReactVideoProps): boolean => {
  const source = props.source;
  const uri = typeof source?.uri === 'string' ? source.uri : '';
  if (!uri) return false;
  if (source?.type === 'm3u8') return true;
  return /\.m3u8(\?|$)/i.test(uri) || /[?&]type=m3u8\b/i.test(uri);
};

const HlsVideo = forwardRef<VideoRef, ReactVideoProps>((props, ref) => {
  const innerRef = useRef<VideoRef | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [failed, setFailed] = useState(false);

  // Expose the underlying react-native-video handle unchanged (seek,
  // setSource, PiP, ...). No dependency list: the child ref is attached during
  // the same commit, so the first layout-effect pass captures the real object.
  useImperativeHandle(ref, () => innerRef.current as VideoRef);

  const hls = isHlsSource(props);
  const uri = typeof props.source?.uri === 'string' ? props.source.uri : '';
  const { paused } = props;

  // Create/destroy the hls.js instance when the URL changes.
  useEffect(() => {
    if (!hls || !uri) return;

    const element = innerRef.current?.nativeHtmlVideoRef?.current;
    if (!element) return;

    // Safari (and any browser with native HLS) needs no help.
    if (element.canPlayType('application/vnd.apple.mpegurl')) return;
    if (!Hls.isSupported()) {
      setFailed(true);
      return;
    }

    setFailed(false);
    const instance = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      backBufferLength: 90,
    });
    hlsRef.current = instance;

    instance.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return;
      // Transient network/media faults are recoverable; hls.js documents
      // exactly these two retries.
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        instance.startLoad();
        return;
      }
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        instance.recoverMediaError();
        return;
      }
      setFailed(true);
      props.onError?.({
        error: {
          errorString: data.details || 'HLS playback failed',
          code: 0,
        },
      });
    });

    instance.loadSource(uri);
    instance.attachMedia(element);

    instance.on(Hls.Events.MANIFEST_PARSED, () => {
      if (!props.paused) {
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
  }, [hls, uri]);

  // Keep play/pause in sync once hls.js owns the element.
  useEffect(() => {
    if (!hlsRef.current) return;
    const element = innerRef.current?.nativeHtmlVideoRef?.current;
    if (!element) return;
    if (paused) element.pause();
    else element.play().catch(() => {});
  }, [paused]);

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
  }, [props.selectedVideoTrack, uri]);

  if (failed) {
    // Let react-native-video surface a normal error card instead of a silent
    // black rectangle: an unusable `src` triggers its `onError` path.
    return (
      <Video
        {...props}
        ref={innerRef}
        source={{ ...props.source, uri: undefined }}
      />
    );
  }

  return (
    <Video
      {...props}
      ref={innerRef}
      source={hls ? { ...props.source, uri: undefined } : props.source}
    />
  );
});

HlsVideo.displayName = 'VideoPlayer';

export default HlsVideo;

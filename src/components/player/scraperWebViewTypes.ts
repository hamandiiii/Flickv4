/**
 * Shared prop contract for the platform-specific `ScraperWebView`.
 *
 * `ScraperWebView.tsx` wraps `react-native-webview` (iOS/Android);
 * `ScraperWebView.web.tsx` wraps Electron's `<webview>` tag (Windows desktop).
 * Both must behave identically from `WebViewScraper`'s point of view.
 */
export interface ScraperWebViewProps {
  /** Changing this remounts the underlying view (used to retry a scrape). */
  webViewKey: number;
  embedUrl: string;
  userAgent: string;
  /** Script that hooks fetch/XHR/<video>.src and reports findings. */
  injectedJavaScript: string;
  /** When false the view is invisible but still rendered at full size. */
  visible: boolean;
  /** Raw string payload posted by the page. */
  onMessage: (data: string) => void;
  onLoadStart: () => void;
  onLoadEnd: () => void;
  onError: (message: string) => void;
  /** Every navigation, so media URLs can be spotted outside the JS hooks. */
  onNavigate: (url: string) => void;
}

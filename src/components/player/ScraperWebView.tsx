import { StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';

import type { ScraperWebViewProps } from './scraperWebViewTypes';

/**
 * iOS/Android implementation: a thin pass-through to `react-native-webview`
 * that normalises the event shapes into the platform-neutral contract.
 *
 * The hidden-but-full-size styling matters — see the class comment on
 * `WebViewScraper` for why a 1x1 viewport breaks some embeds.
 */
export const ScraperWebView = ({
  webViewKey,
  embedUrl,
  userAgent,
  injectedJavaScript,
  visible,
  onMessage,
  onLoadStart,
  onLoadEnd,
  onError,
  onNavigate,
}: ScraperWebViewProps) => (
  <WebView
    key={webViewKey}
    source={{ uri: embedUrl }}
    // Present as a normal mobile browser so Cloudflare's JS challenge runs.
    userAgent={userAgent}
    applicationNameForUserAgent="Chrome/126.0.0.0"
    injectedJavaScript={injectedJavaScript}
    // Patch fetch/XHR/<video>.src before the page's own JS runs so we
    // catch VidLink's /api/b/* JSON and the subsequent playlist request.
    injectedJavaScriptBeforeContentLoaded={injectedJavaScript}
    injectedJavaScriptBeforeContentLoadedForMainFrameOnly={false}
    // Inject into nested (cross-origin) iframes too - the stream request
    // originates inside the embedded player frame, not the top document.
    injectedJavaScriptForMainFrameOnly={false}
    onMessage={(event) => onMessage(event.nativeEvent.data)}
    onLoadStart={onLoadStart}
    onLoadEnd={onLoadEnd}
    onError={(event) =>
      onError(
        `WebView error: ${event.nativeEvent.code} ${event.nativeEvent.description}`,
      )
    }
    onShouldStartLoadWithRequest={(req) => {
      onNavigate(req.url);
      return true;
    }}
    javaScriptEnabled
    domStorageEnabled
    startInLoadingState
    allowsInlineMediaPlayback
    mediaPlaybackRequiresUserAction={false}
    // Cookies must persist so the Cloudflare `cf_clearance` cookie set after
    // the challenge is reused on later requests (bypassing repeat checks).
    thirdPartyCookiesEnabled
    sharedCookiesEnabled
    // Let the interactive challenge open in the same view.
    setSupportMultipleWindows={false}
    originWhitelist={['*']}
    style={
      visible ? StyleSheet.absoluteFill : [StyleSheet.absoluteFill, styles.hidden]
    }
  />
);

const styles = StyleSheet.create({
  // Android often ignores opacity on a parent View wrapping a WebView, so
  // hide the WebView itself too.
  hidden: { opacity: 0 },
});

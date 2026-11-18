import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';

import type { ScraperWebViewProps } from './scraperWebViewTypes';

/**
 * Windows desktop implementation: Electron's `<webview>` tag.
 *
 * Why not the `react-native-web-webview` iframe shim? An iframe cannot be
 * scripted cross-origin, so the scraper could never patch `fetch`/XHR inside
 * the player frame — which is exactly where the stream URL is produced. A
 * `<webview>` gives us a real guest `webContents` we can hook through the
 * DevTools protocol (see `desktop/scraper-bridge.js`).
 *
 * The element is created imperatively because React does not know the
 * `<webview>` custom element and would otherwise drop its attributes.
 */

interface WebviewElement extends HTMLElement {
  getWebContentsId(): number;
}

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
}: ScraperWebViewProps) => {
  const hostRef = useRef<View | null>(null);
  const elementRef = useRef<WebviewElement | null>(null);

  // Keep the latest callbacks/visibility without re-creating the guest.
  const latest = useRef({
    visible,
    onMessage,
    onLoadStart,
    onLoadEnd,
    onError,
    onNavigate,
  });
  latest.current = { visible, onMessage, onLoadStart, onLoadEnd, onError, onNavigate };

  // Create the guest once per `webViewKey` (a new key = a fresh scrape).
  useEffect(() => {
    const bridge =
      typeof window !== 'undefined' ? window.coffeDesktop : undefined;
    const host = hostRef.current as unknown as HTMLElement | null;
    if (!bridge?.attachScraper || !host) return;

    const el = document.createElement('webview') as WebviewElement;
    el.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%;border:0;background:transparent;';
    el.style.opacity = latest.current.visible ? '1' : '0';
    el.style.pointerEvents = latest.current.visible ? 'auto' : 'none';
    // Persist cookies so the Cloudflare `cf_clearance` cookie survives between
    // scrapes instead of re-challenging every single time.
    el.setAttribute('partition', 'persist:coffe-scraper');
    el.setAttribute('useragent', userAgent);

    let disposed = false;
    let webContentsId: number | null = null;
    let attached = false;
    const listeners: Array<[string, EventListener]> = [];

    const on = (name: string, fn: (event: any) => void) => {
      const wrapped = fn as EventListener;
      el.addEventListener(name, wrapped);
      listeners.push([name, wrapped]);
    };

    on('did-start-loading', () => latest.current.onLoadStart());
    on('did-stop-loading', () => latest.current.onLoadEnd());
    on('did-fail-load', (event: any) => {
      // Subframe/ad failures are normal on ad-heavy embeds; only the main
      // document failing means the scrape cannot proceed.
      if (event.isMainFrame === false) return;
      // -3 = ERR_ABORTED (e.g. a redirect superseded the request).
      if (event.errorCode === -3) return;
      latest.current.onError(
        `WebView load error: ${event.errorDescription || event.errorCode}`,
      );
    });
    on('did-navigate', (event: any) => latest.current.onNavigate(event.url));
    on('did-navigate-in-page', (event: any) => {
      if (event.isMainFrame) latest.current.onNavigate(event.url);
    });

    const attachNow = () => {
      if (attached || disposed) return;
      let id: number;
      try {
        id = el.getWebContentsId();
      } catch {
        // Guest not created yet — `did-attach`/`dom-ready` will call us again.
        return;
      }
      attached = true;
      webContentsId = id;
      bridge
        .attachScraper(id, injectedJavaScript)
        .catch((err) => console.error('[coffe] scraper attach failed', err));
    };
    on('did-attach', attachNow);
    on('dom-ready', attachNow);

    const unsubscribe = bridge.onScraperMessage((payload) => {
      if (!payload || payload.id !== webContentsId) return;
      latest.current.onMessage(payload.data);
    });

    // The guest must be in the DOM before `src` is assigned.
    host.appendChild(el);
    elementRef.current = el;
    el.setAttribute('src', embedUrl);

    return () => {
      disposed = true;
      unsubscribe();
      for (const [name, fn] of listeners) el.removeEventListener(name, fn);
      if (webContentsId != null) {
        bridge.detachScraper(webContentsId).catch(() => {});
      }
      el.remove();
      elementRef.current = null;
    };
  }, [webViewKey, embedUrl, userAgent, injectedJavaScript]);

  // Visibility only — the guest must stay rendered at full size so embeds do
  // not mistake it for a 1x1 bot viewport.
  useEffect(() => {
    const el = elementRef.current;
    if (!el) return;
    el.style.opacity = visible ? '1' : '0';
    el.style.pointerEvents = visible ? 'auto' : 'none';
  }, [visible]);

  return <View ref={hostRef} style={styles.host} />;
};

const styles = StyleSheet.create({
  host: {
    flex: 1,
    position: 'relative',
    overflow: 'hidden',
  },
});

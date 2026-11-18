import { useCallback, useEffect, useState } from 'react';

import type { DesktopStorageInfo } from '@/src/types/desktop';

/**
 * True only inside the Windows desktop shell (Electron). Native builds and a
 * plain browser both return false, so desktop-only UI stays hidden.
 */
export const isDesktopApp = (): boolean =>
  typeof window !== 'undefined' && window.coffeDesktop?.isDesktop === true;

export interface UseDesktopStorage {
  /** False on iOS/Android/browser — hide the settings entry entirely. */
  isDesktop: boolean;
  info: DesktopStorageInfo | null;
  busy: boolean;
  error: string | null;
  /** Opens the native folder picker. */
  choose(): Promise<void>;
  /** Applies a typed-in path. */
  applyPath(dir: string): Promise<boolean>;
  /** Restores the platform default (Downloads\CoFFe House). */
  reset(): Promise<void>;
  /** Opens the folder in Explorer. */
  openFolder(): Promise<void>;
  /** Re-reads the current value from the shell. */
  refresh(): Promise<void>;
  /** Closing the window hides the app to the notification area. */
  closeToTray: boolean;
  /** Persists the close-to-tray preference in the shell. */
  setCloseToTray(value: boolean): Promise<void>;
}

/**
 * Desktop storage/download folder, backed by the Electron bridge.
 *
 * The shell persists the choice in `userData/desktop-settings.json` and routes
 * every download into that folder, so this hook is a thin view over it.
 */
export const useDesktopStorage = (): UseDesktopStorage => {
  const isDesktop = isDesktopApp();
  const [info, setInfo] = useState<DesktopStorageInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closeToTray, setCloseToTrayState] = useState(true);

  const refresh = useCallback(async () => {
    const bridge = typeof window !== 'undefined' ? window.coffeDesktop : undefined;
    if (!bridge) return;
    try {
      setInfo(await bridge.getStorage());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    const bridge = typeof window !== 'undefined' ? window.coffeDesktop : undefined;
    if (!bridge) return;
    void refresh();
    return bridge.onStorageChanged((next) => {
      setInfo(next);
      setError(null);
    });
  }, [refresh]);

  useEffect(() => {
    const bridge = typeof window !== 'undefined' ? window.coffeDesktop : undefined;
    if (!bridge?.getPreferences) return;
    let active = true;
    void bridge
      .getPreferences()
      .then((prefs) => {
        if (active) setCloseToTrayState(prefs.closeToTray !== false);
      })
      .catch(() => {
        /* keep the default */
      });
    const off = bridge.onPreferencesChanged?.((prefs) => {
      setCloseToTrayState(prefs.closeToTray !== false);
    });
    return () => {
      active = false;
      off?.();
    };
  }, []);

  const choose = useCallback(async () => {
    const bridge = typeof window !== 'undefined' ? window.coffeDesktop : undefined;
    if (!bridge) return;
    setBusy(true);
    setError(null);
    try {
      const result = await bridge.chooseStorage();
      if (!result.canceled) {
        setInfo({ dir: result.dir, defaultDir: result.defaultDir });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const applyPath = useCallback(async (dir: string) => {
    const bridge = typeof window !== 'undefined' ? window.coffeDesktop : undefined;
    if (!bridge || !dir.trim()) return false;
    setBusy(true);
    setError(null);
    try {
      const result = await bridge.setStorage(dir.trim());
      setInfo({ dir: result.dir, defaultDir: result.defaultDir });
      // The shell falls back to the previous folder when a path is invalid.
      return result.dir.toLowerCase() === dir.trim().toLowerCase();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const reset = useCallback(async () => {
    const bridge = typeof window !== 'undefined' ? window.coffeDesktop : undefined;
    if (!bridge) return;
    setBusy(true);
    setError(null);
    try {
      const result = await bridge.resetStorage();
      setInfo({ dir: result.dir, defaultDir: result.defaultDir });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const openFolder = useCallback(async () => {
    const bridge = typeof window !== 'undefined' ? window.coffeDesktop : undefined;
    if (!bridge) return;
    try {
      const result = await bridge.openStorage();
      if (!result.ok) {
        setError(result.error || 'Could not open the folder.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const setCloseToTray = useCallback(async (value: boolean) => {
    const bridge = typeof window !== 'undefined' ? window.coffeDesktop : undefined;
    if (!bridge?.setPreferences) return;
    // Optimistic: the switch should not lag behind the tap.
    setCloseToTrayState(value);
    try {
      const prefs = await bridge.setPreferences({ closeToTray: value });
      setCloseToTrayState(prefs.closeToTray !== false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCloseToTrayState(!value);
    }
  }, []);

  return {
    isDesktop,
    info,
    busy,
    error,
    choose,
    applyPath,
    reset,
    openFolder,
    refresh,
    closeToTray,
    setCloseToTray,
  };
};

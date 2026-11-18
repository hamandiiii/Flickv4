import { Dimensions, PixelRatio, Platform, ScaledSize } from 'react-native';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

/**
 * Desktop/laptop browser window (Expo web + the Electron shell). Wide enough
 * that phone/tablet sizing looks comically oversized, so it gets its own
 * column count and padding.
 */
export const isDesktopWidth = (width: number): boolean =>
  Platform.OS === 'web' && width >= 900;

/**
 * Tablet detection based on physical pixel dimensions and logical size.
 * Mirrors common RN heuristics so layouts can widen on larger screens.
 */
export const isTablet = (
  width: number = SCREEN_WIDTH,
  height: number = SCREEN_HEIGHT,
): boolean => {
  const pixelDensity = PixelRatio.get();
  const adjustedWidth = width * pixelDensity;
  const adjustedHeight = height * pixelDensity;
  return (
    adjustedWidth >= 1000 ||
    adjustedHeight >= 1000 ||
    (Math.min(width, height) >= 600 && Math.max(width, height) >= 900)
  );
};

export type DeviceKind = 'phone' | 'tablet' | 'desktop' | 'tv';

export const getDeviceKind = (
  size: Pick<ScaledSize, 'width' | 'height'>,
  tv: boolean,
): DeviceKind => {
  if (tv) return 'tv';
  if (isDesktopWidth(size.width)) return 'desktop';
  return isTablet(size.width, size.height) ? 'tablet' : 'phone';
};

/** Number of poster columns to render in a grid for the given device. */
export const getGridColumns = (kind: DeviceKind): number => {
  switch (kind) {
    case 'tv':
      return 6;
    case 'desktop':
      return 6;
    case 'tablet':
      return 4;
    default:
      return 3;
  }
};

/** Poster card width (px) for horizontal rows. */
export const getCardWidth = (kind: DeviceKind, screenWidth: number): number => {
  switch (kind) {
    case 'tv':
      return 200;
    case 'desktop': {
      // Six cards across the content area, bounded so rows stay readable on
      // ultrawide windows and cards never shrink below a legible size.
      const available = screenWidth - 32 * 2 - 12 * 5;
      return Math.round(Math.min(210, Math.max(150, available / 6)));
    }
    case 'tablet':
      return screenWidth * 0.24;
    default:
      return screenWidth * 0.36;
  }
};

export const POSTER_ASPECT_RATIO = 1.5; // height / width for TMDB posters

/** Poster card width (px) for ranked Top 10 rows — slightly larger than standard. */
export const getTopTenCardWidth = (
  kind: DeviceKind,
  screenWidth: number,
): number => Math.round(getCardWidth(kind, screenWidth) * 1.15);

export const getHorizontalPadding = (kind: DeviceKind): number => {
  switch (kind) {
    case 'tv':
      return 48;
    case 'desktop':
      return 32;
    case 'tablet':
      return 16;
    default:
      return 16;
  }
};

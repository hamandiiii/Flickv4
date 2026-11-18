/**
 * Native (iOS / Android) player: straight re-export of `react-native-video`.
 *
 * The web build resolves `VideoPlayer.web.tsx` instead, which adds HLS
 * playback through `hls.js` (Chromium cannot play `.m3u8` on its own).
 */
export { default } from 'react-native-video';

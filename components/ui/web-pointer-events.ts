/**
 * gluestack's `.web.tsx` primitives render plain `<div>`s, so the React Native
 * `pointerEvents` prop never reaches CSS: React DOM drops the unknown attribute
 * and every overlay keeps `pointer-events: auto`. A full-screen
 * `pointerEvents="none"` layer then swallows clicks meant for the controls
 * underneath it (this is what made the in-player back button unclickable).
 *
 * Map the RN values onto the small set of utility classes declared in
 * `global.css` instead.
 */
const CLASS_BY_VALUE: Record<string, string> = {
  none: 'rn-pe-none',
  auto: 'rn-pe-auto',
  'box-none': 'rn-pe-box-none',
  'box-only': 'rn-pe-box-only',
};

export const webPointerEventsClass = (value: unknown): string =>
  typeof value === 'string' ? (CLASS_BY_VALUE[value] ?? '') : '';

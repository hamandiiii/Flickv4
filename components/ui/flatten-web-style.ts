import { StyleSheet, type StyleProp } from 'react-native';

/**
 * gluestack's `.web.tsx` components render raw DOM elements (`<div>`, `<span>`,
 * `<h1>`...). React DOM rejects React Native style *arrays*
 * (`style={[styles.a, styles.b]}`) with
 * `TypeError: Indexed property setter is not supported`, which crashes the
 * whole web bundle on the first render.
 *
 * Flattening here keeps every existing call site working on both native and
 * web without touching app code.
 */
export const flattenWebStyle = (style: StyleProp<unknown>): object | undefined => {
  if (!style) return undefined;
  return StyleSheet.flatten(style as never) as object;
};

import React from 'react';
import { boxStyle } from './styles';
import { flattenWebStyle } from '../flatten-web-style';
import { webPointerEventsClass } from '../web-pointer-events';

import type { VariantProps } from '@gluestack-ui/utils/nativewind-utils';

type IBoxProps = React.ComponentPropsWithoutRef<'div'> &
  VariantProps<typeof boxStyle> & {
    className?: string;
    pointerEvents?: 'auto' | 'none' | 'box-none' | 'box-only';
  };

const Box = React.forwardRef<HTMLDivElement, IBoxProps>(function Box(
  { className, style, pointerEvents, ...props },
  ref
) {
  const pointerClass = webPointerEventsClass(pointerEvents);
  return (
    <div
      ref={ref}
      className={boxStyle({
        class: [className, pointerClass].filter(Boolean).join(' '),
      })}
      style={flattenWebStyle(style)}
      {...props}
    />
  );
});

Box.displayName = 'Box';
export { Box };

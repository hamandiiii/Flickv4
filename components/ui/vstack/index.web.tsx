import React from 'react';
import type { VariantProps } from '@gluestack-ui/utils/nativewind-utils';

import { vstackStyle } from './styles';
import { flattenWebStyle } from '../flatten-web-style';
import { webPointerEventsClass } from '../web-pointer-events';

type IVStackProps = React.ComponentProps<'div'> &
  VariantProps<typeof vstackStyle> & {
    pointerEvents?: 'auto' | 'none' | 'box-none' | 'box-only';
  };

const VStack = React.forwardRef<React.ComponentRef<'div'>, IVStackProps>(
  function VStack({ className, space, reversed, style, pointerEvents, ...props }, ref) {
    const pointerClass = webPointerEventsClass(pointerEvents);
    return (
      <div
        className={vstackStyle({
          space,
          reversed: reversed as boolean,
          class: [className, pointerClass].filter(Boolean).join(' '),
        })}
        style={flattenWebStyle(style)}
        {...props}
        ref={ref}
      />
    );
  }
);

VStack.displayName = 'VStack';

export { VStack };

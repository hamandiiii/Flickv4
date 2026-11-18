import React from 'react';
import type { VariantProps } from '@gluestack-ui/utils/nativewind-utils';
import { hstackStyle } from './styles';
import { flattenWebStyle } from '../flatten-web-style';
import { webPointerEventsClass } from '../web-pointer-events';

type IHStackProps = React.ComponentPropsWithoutRef<'div'> &
  VariantProps<typeof hstackStyle> & {
    pointerEvents?: 'auto' | 'none' | 'box-none' | 'box-only';
  };

const HStack = React.forwardRef<React.ComponentRef<'div'>, IHStackProps>(
  function HStack({ className, space, reversed, style, pointerEvents, ...props }, ref) {
    const pointerClass = webPointerEventsClass(pointerEvents);
    return (
      <div
        className={hstackStyle({
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

HStack.displayName = 'HStack';

export { HStack };

import React from 'react';
import { centerStyle } from './styles';
import { flattenWebStyle } from '../flatten-web-style';
import { webPointerEventsClass } from '../web-pointer-events';

import type { VariantProps } from '@gluestack-ui/utils/nativewind-utils';

type ICenterProps = React.ComponentPropsWithoutRef<'div'> &
  VariantProps<typeof centerStyle> & {
    pointerEvents?: 'auto' | 'none' | 'box-none' | 'box-only';
  };

const Center = React.forwardRef<HTMLDivElement, ICenterProps>(function Center(
  { className, style, pointerEvents, ...props },
  ref
) {
  const pointerClass = webPointerEventsClass(pointerEvents);
  return (
    <div
      className={centerStyle({
        class: [className, pointerClass].filter(Boolean).join(' '),
      })}
      style={flattenWebStyle(style)}
      {...props}
      ref={ref}
    />
  );
});

Center.displayName = 'Center';

export { Center };

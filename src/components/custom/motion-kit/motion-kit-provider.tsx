// @polsia:user-owned
'use client';

// MotionKitProvider — loads motion's features once and makes motion honor the OS
// reduced-motion setting.
// When to use: wrap a page ONCE when it does not render through <LandingPage> (which
// already provides LazyMotion + MotionConfig). Not needed inside LandingPage; nesting
// is harmless (the inner LazyMotion only adds features and is non-strict).

import { domAnimation, LazyMotion, MotionConfig } from 'motion/react';
import type { ReactNode } from 'react';

export type MotionKitProviderProps = {
  children: ReactNode;
};

/**
 * Kit components render `m.*` elements, which animate only below a LazyMotion.
 * `domAnimation` = animations + gestures (no drag/layout), which is all the kit uses
 * (parallax transforms, CSS reveals). Trimmer bundle than `domMax`, loaded app-wide.
 * Not `strict`, so a stray `motion.*` element doesn't throw.
 */
export function MotionKitProvider({ children }: MotionKitProviderProps) {
  return (
    <LazyMotion features={domAnimation}>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}

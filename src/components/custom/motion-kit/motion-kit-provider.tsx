// @polsia:user-owned
'use client';

// MotionKitProvider — loads motion's features once and makes motion honor the OS
// reduced-motion setting.
// When to use: wrap a page ONCE when it does not render through <LandingPage> (which
// already provides LazyMotion + MotionConfig). Not needed inside LandingPage; nesting
// is harmless (the inner LazyMotion only adds features and is non-strict).

import { domMax, LazyMotion, MotionConfig } from 'motion/react';
import type { ReactNode } from 'react';

export type MotionKitProviderProps = {
  children: ReactNode;
};

/**
 * Kit components render `m.*` elements, which animate only below a LazyMotion.
 * `domMax` = animations + gestures + drag + layout, so page-level code can also use
 * layout animations. Not `strict`, so a stray `motion.*` element doesn't throw.
 */
export function MotionKitProvider({ children }: MotionKitProviderProps) {
  return (
    <LazyMotion features={domMax}>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}

// @polsia:user-owned
'use client';

// Parallax — the child drifts slower/faster than the page while it crosses the viewport.
// When to use: one image or decorative shape per section, inside a clipped frame (`clip`).
// When not to: text blocks, many elements on one screen, or the page's signature moment
// (use ScrollZoomHero / ImageSequence). Transform-only; no per-frame React renders.

import { type MotionValue, useScroll, useTransform } from 'motion/react';
import * as m from 'motion/react-m';
import { type ReactNode, useRef } from 'react';
import { cn } from '@/lib/utils';
import { clamp } from './easing';
import { useShouldReduceMotion } from './hooks';

export type ParallaxProps = {
  children: ReactNode;
  /**
   * -1..1. Positive drifts down (feels farther away), negative drifts up (feels
   * closer). 0.2 is subtle, 0.5 is strong. Max travel is ±15% of the element height.
   */
  speed?: number;
  /**
   * A number is a static scale (e.g. 1.15 hides the frame edges while the child drifts
   * inside a `clip` frame). A [from, to] pair zooms the child across the scroll.
   */
  scale?: number | readonly [number, number];
  /** Clip the child to this box (overflow hidden). Pair with a scale > 1. */
  clip?: boolean;
  /**
   * Set for elements visible at page load (hero): the effect then starts at scroll 0,
   * so nothing jumps at hydration.
   */
  aboveFold?: boolean;
  className?: string;
  innerClassName?: string;
};

export function Parallax({
  children,
  speed = 0.2,
  scale,
  clip = false,
  aboveFold = false,
  className,
  innerClassName,
}: ParallaxProps) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useShouldReduceMotion();
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: aboveFold ? ['start start', 'end start'] : ['start end', 'end start'],
  });
  const travel = clamp(speed, -1, 1) * 15;
  const y = useTransform(
    scrollYProgress,
    [0, 1],
    aboveFold ? ['0%', `${travel}%`] : [`${-travel}%`, `${travel}%`],
  );
  const [scaleFrom, scaleTo] = typeof scale === 'number' ? [scale, scale] : (scale ?? [1, 1]);
  const scaleValue: MotionValue<number> = useTransform(
    scrollYProgress,
    [0, 1],
    [scaleFrom, scaleTo],
  );

  return (
    <div ref={ref} className={cn('relative', clip && 'overflow-hidden', className)}>
      <m.div
        className={cn('h-full w-full', innerClassName)}
        style={reduce ? { scale: scaleFrom } : { y, scale: scaleValue }}
      >
        {children}
      </m.div>
    </div>
  );
}

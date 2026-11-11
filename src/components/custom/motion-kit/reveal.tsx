// @polsia:user-owned
'use client';

// Reveal — a short entrance for one block (heading group, card, image) as it scrolls in.
// When to use: section headings, key visuals, a few important blocks per page.
// When not to: every paragraph, or long lists (use Stagger). For content visible at
// page load (the hero), pass trigger="load" (pure CSS, plays from first paint).

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { clamp } from './easing';
import { type StyleWithVars, useRevealState } from './hooks';
import styles from './motion-kit.module.css';

export type RevealVariant = 'fade-up' | 'fade' | 'blur' | 'clip-up' | 'scale';
export type RevealTag =
  | 'div'
  | 'section'
  | 'article'
  | 'header'
  | 'figure'
  | 'li'
  | 'p'
  | 'span'
  | 'h1'
  | 'h2'
  | 'h3';

export type RevealProps = {
  children: ReactNode;
  /** Entrance look. Default `fade-up`. */
  variant?: RevealVariant;
  /** Seconds before the entrance starts. Default 0. */
  delay?: number;
  /** Seconds. Default 0.6 (keep 0.4–0.8). */
  duration?: number;
  /** Travel in px for fade-up/blur/clip-up. Default 16, capped at 24. */
  distance?: number;
  /** Play once (default) or every time it re-enters. */
  once?: boolean;
  /** Fraction of the element visible before it plays. Default 0.2. */
  amount?: number;
  /** `view` (default): on scroll into view. `load`: CSS keyframe from first paint. */
  trigger?: 'view' | 'load';
  as?: RevealTag;
  className?: string;
  id?: string;
};

const variantClass: Record<RevealVariant, string | undefined> = {
  'fade-up': styles.fadeUp,
  fade: styles.fade,
  blur: styles.blur,
  'clip-up': styles.clipUp,
  scale: styles.scale,
};

export function Reveal({
  children,
  variant = 'fade-up',
  delay = 0,
  duration = 0.6,
  distance = 16,
  once = true,
  amount = 0.2,
  trigger = 'view',
  as: Tag = 'div',
  className,
  id,
}: RevealProps) {
  const { ref, state } = useRevealState({ once, amount, disabled: trigger === 'load' });
  const style: StyleWithVars = {
    '--mk-delay': `${delay}s`,
    '--mk-duration': `${duration}s`,
    '--mk-distance': `${clamp(distance, 0, 24)}px`,
  };
  return (
    <Tag
      ref={ref}
      id={id}
      className={cn(styles.reveal, variantClass[variant], className)}
      style={style}
      data-state={trigger === 'load' ? undefined : state}
      data-trigger={trigger}
    >
      {children}
    </Tag>
  );
}

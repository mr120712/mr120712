// @polsia:user-owned
'use client';

// Shared hooks for the motion kit. Everything here is hydration-safe: the server
// snapshot is always the "no preference / fine pointer / idle" answer, so the
// first client render matches the SSR HTML and the real value arrives right after.

import { MotionConfigContext } from 'motion/react';
import type { CSSProperties, RefObject } from 'react';
import { useCallback, useContext, useEffect, useState, useSyncExternalStore } from 'react';

/** Inline style object that also accepts CSS custom properties (`--foo`). */
export type StyleWithVars = CSSProperties & Record<`--${string}`, string | number>;

/** Subscribes to a CSS media query. Returns `serverValue` during SSR and hydration. */
export function useMediaQuery(query: string, serverValue = false): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => serverValue,
  );
}

/**
 * True when motion should be reduced: the OS `prefers-reduced-motion` setting, or an
 * enclosing `<MotionConfig reducedMotion="always">`. Unlike motion's `useReducedMotion`,
 * this is hydration-safe (false on the server and on the hydration render).
 */
export function useShouldReduceMotion(): boolean {
  const { reducedMotion } = useContext(MotionConfigContext);
  const prefersReduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  return reducedMotion === 'always' || prefersReduced;
}

/** True on touch-first devices (coarse pointer or no hover). Use it to skip hover effects. */
export function useIsCoarsePointer(): boolean {
  return useMediaQuery('(pointer: coarse), (hover: none)');
}

/**
 * Entrance state for in-view reveals.
 * - `idle`: server/no-JS/reduced-motion state and the state of anything already on screen
 *   at hydration. Rendered at its final, visible look (never flashes).
 * - `hidden`: armed after mount for elements that start off-screen.
 * - `shown`: the element entered the viewport; CSS/motion plays the entrance.
 */
export type RevealState = 'idle' | 'hidden' | 'shown';

export type RevealOptions = {
  /** Play only the first time (default true). When false, re-hides once fully off-screen. */
  once?: boolean;
  /** Fraction (0–1) of the element that must be visible to trigger. Default 0.2. */
  amount?: number;
  /** Skip arming entirely (e.g. `trigger="load"` handled by CSS). */
  disabled?: boolean;
};

/**
 * Tracks an element's reveal state with an IntersectionObserver (plus a scroll check
 * while the element is near the viewport) and no per-frame
 * React state (it re-renders at most twice: arm, then show).
 * Returns a callback ref to attach to the element, plus the current state.
 */
export function useRevealState({
  once = true,
  amount = 0.2,
  disabled = false,
}: RevealOptions = {}) {
  const reduce = useShouldReduceMotion();
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [state, setState] = useState<RevealState>('idle');
  const ref = useCallback((node: HTMLElement | null) => setElement(node), []);

  useEffect(() => {
    if (!element || disabled || reduce) {
      setState('idle');
      return;
    }
    const rect = element.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    // Only arm elements that are fully off-screen right now: content the visitor
    // can already see is never hidden after the fact.
    if (rect.top >= viewportHeight || rect.bottom <= 0) setState('hidden');

    const threshold = Math.min(Math.max(amount, 0), 1);
    // Visibility is judged on the element's layout box, never its painted area:
    // Chromium applies the target's own clip-path to IntersectionObserver, so a
    // hidden clip-path wipe (ImageReveal, clip-up) reports a zero ratio forever and
    // would never reveal. The observer only wakes us up; this box test decides.
    const visibleEnough = () => {
      const box = element.getBoundingClientRect();
      const rootHeight = window.innerHeight;
      const visible = Math.min(box.bottom, rootHeight) - Math.max(box.top, 0);
      if (visible <= 0 || box.height <= 0) return false;
      // Tall elements can never reach a high ratio; also accept "fills the viewport".
      return visible / box.height >= threshold || visible >= rootHeight * threshold;
    };
    const isOffscreen = () => {
      const box = element.getBoundingClientRect();
      return box.top >= window.innerHeight || box.bottom <= 0;
    };

    let frame = 0;
    let done = false;
    const check = () => {
      frame = 0;
      if (done) return;
      if (visibleEnough()) {
        setState((current) => (current === 'hidden' ? 'shown' : current));
        if (once) stop();
      } else if (!once && isOffscreen()) {
        setState('hidden');
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    // Scroll/resize listeners run only while the element is near the viewport.
    let listening = false;
    const listen = (on: boolean) => {
      if (on === listening) return;
      listening = on;
      const method = on ? 'addEventListener' : 'removeEventListener';
      window[method]('scroll', schedule, { passive: true } as AddEventListenerOptions);
      window[method]('resize', schedule);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const near = entry.isIntersecting;
          listen(near);
          if (near) schedule();
          else if (!once) setState('hidden');
        }
      },
      // Wake up a little before the box enters so the listener is armed in time.
      { rootMargin: '25% 0px 25% 0px', threshold: [0] },
    );
    const stop = () => {
      done = true;
      observer.disconnect();
      listen(false);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    };
    observer.observe(element);
    return stop;
  }, [element, disabled, reduce, once, amount]);

  return { ref, state, reduce } as const;
}

/* ---------------------------------------------------------------------------------- */
/* Pinning (position: sticky) support                                                  */
/* ---------------------------------------------------------------------------------- */

/** Overflow values that make an element a scroll container (and so break sticky). */
const SCROLL_CONTAINER = /^(hidden|auto|scroll|overlay)$/;

function describeElement(node: Element): string {
  const classes = typeof node.className === 'string' ? node.className.trim() : '';
  const shown = classes.split(/\s+/).filter(Boolean).slice(0, 8).join(' ');
  return `<${node.tagName.toLowerCase()}${node.id ? ` id="${node.id}"` : ''}${shown ? ` class="${shown}"` : ''}>`;
}

/**
 * The first ancestor of `node` that stops a `position: sticky` descendant from pinning
 * to the page: any scroll container between it and the document scroller, i.e. a
 * computed `overflow-x` or `overflow-y` of hidden/auto/scroll (`clip` and `visible` are
 * fine). `<body>` only counts when its overflow is not propagated to the viewport
 * (that is, when `<html>` sets an overflow of its own). Null when sticky works.
 */
export function findPinBreaker(node: Element): { element: Element; overflow: string } | null {
  const root = document.documentElement;
  const scroller = document.scrollingElement ?? root;
  const html = getComputedStyle(root);
  // <body>'s overflow moves to the viewport unless <html> sets one of its own.
  const bodyPropagated = html.overflowX === 'visible' && html.overflowY === 'visible';
  let el = node.parentElement;
  while (el && el !== scroller && el !== root) {
    const style = getComputedStyle(el);
    const x = style.overflowX;
    const y = style.overflowY;
    const breaks = SCROLL_CONTAINER.test(x) || SCROLL_CONTAINER.test(y);
    if (breaks && !(el === document.body && bodyPropagated)) {
      const overflow = x === y ? `overflow: ${x}` : `overflow-x: ${x}; overflow-y: ${y}`;
      return { element: el, overflow };
    }
    el = el.parentElement;
  }
  return null;
}

/** Primitive names already reported per ancestor: one warning each, never on resize. */
const warnedBreakers = new WeakMap<Element, Set<string>>();

/**
 * Whether a pinned (`position: sticky`) primitive can actually pin where it was placed.
 * After mount and on every resize it walks the ancestors of `ref`'s element (the sticky
 * element, or a kit-owned wrapper of it) up to the document scroller and looks for a
 * scroll container (`overflow: hidden | auto | scroll` on either axis), which silently
 * turns sticky off. Returns false when one is found: the primitive then renders its
 * unpinned, fully readable fallback, sets `data-mk-pin="broken"` on its root, and in
 * development warns once, naming the ancestor. Never touches ancestor styles.
 * True on the server and on the hydration render (SSR HTML is unchanged).
 */
export function usePinSupport(ref: RefObject<HTMLElement | null>, name = 'motion-kit'): boolean {
  const [pinnable, setPinnable] = useState(true);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const check = () => {
      const breaker = findPinBreaker(node);
      setPinnable(!breaker);
      if (!breaker || process.env.NODE_ENV === 'production') return;
      const warned = warnedBreakers.get(breaker.element) ?? new Set<string>();
      if (warned.has(name)) return;
      warnedBreakers.set(breaker.element, warned.add(name));
      // biome-ignore lint/suspicious/noConsole: development-only authoring warning.
      console.warn(
        `[motion-kit] ${name} cannot pin: its ancestor ${describeElement(breaker.element)} has ` +
          `${breaker.overflow}, which turns position: sticky off. It renders unpinned ` +
          '(data-mk-pin="broken"). Use `overflow: clip` (or `overflow-x: clip`) instead of ' +
          'hidden/auto/scroll on that ancestor to keep horizontal bleed contained.',
        breaker.element,
      );
    };
    check();
    let frame = 0;
    const onResize = () => {
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          check();
        });
      }
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [ref, name]);
  return pinnable;
}

/** `data-mk-pin` value for a pinned primitive's root (undefined while it can pin). */
export function pinAttr(pinnable: boolean): 'broken' | undefined {
  return pinnable ? undefined : 'broken';
}

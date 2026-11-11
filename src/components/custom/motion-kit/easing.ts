// @polsia:user-owned
// Shared easing curves for the motion kit. Arrays feed `motion` transitions;
// the `css*` strings feed CSS transitions/animations (see motion-kit.module.css).

export type CubicBezier = readonly [number, number, number, number];

/** Fast start, long soft landing. The default "premium" entrance curve. */
export const EASE_OUT_EXPO: CubicBezier = [0.16, 1, 0.3, 1];
/** Slightly firmer than expo; good for UI-sized moves. */
export const EASE_OUT_QUART: CubicBezier = [0.25, 1, 0.5, 1];
/** Symmetric curve for scroll-linked or looping moves. */
export const EASE_IN_OUT: CubicBezier = [0.65, 0, 0.35, 1];

/** Converts a bezier tuple to a CSS `cubic-bezier()` string. */
export function cssEase(curve: CubicBezier): string {
  return `cubic-bezier(${curve.join(', ')})`;
}

/** Clamps `value` into [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// @polsia:user-owned — class names the framework-owned layout merges onto <html> and <body>.
//
// This is THE seam for `next/font`: its loaders return a CLASS, not a CSS value, and the
// class must sit on an ancestor of everything — including Radix portals that mount on
// document.body. Load fonts in a user-owned `src/lib/fonts.ts` and compose them here:
//
//   import { display, body } from '@/lib/fonts';
//   export const htmlClassName = `${display.variable} ${body.variable}`;
//   export const bodyClassName = '';
//
// then point `--font-display` / `--font-body` in `src/app/brand-theme.css` at the
// variables those classes define (e.g. `--font-body: var(--font-body-loaded), sans-serif`).
// Any other root-level class (a density or color-scheme hook) can go here too; the layout
// already sets `min-h-screen bg-background font-body text-foreground antialiased` on <body>
// and next-themes toggles `dark` on <html>. Both values go through `cn()`, so a Tailwind
// utility you add here wins over the framework's conflicting one (e.g. `font-sans` replaces
// `font-body` on <body>); non-utility class names such as next/font's pass through untouched.

export const htmlClassName = '';
export const bodyClassName = '';

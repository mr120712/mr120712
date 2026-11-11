// @polsia:user-owned — brand identity. Edit freely. `site.ts` re-exports
// siteName/siteDescription; `manifest.ts` + `opengraph-image.tsx` read `brandVisual`.

export const siteName = 'Solco';
export const siteDescription =
  'Cerca brani e artisti, esplora i generi e segui le fonti musicali disponibili.';

// PWA + social-share colors, aligned with the light and dark Solco themes.
export const brandVisual = {
  /** PWA browser-UI / status-bar color — usually your background or primary. */
  themeColor: '#08151f',
  /** PWA splash + install background. */
  backgroundColor: '#08151f',
  /** Social-share (OG/Twitter) image. */
  og: {
    background: '#08151f',
    foreground: '#edf5f6',
    /** Second line under the site name; '' hides it. */
    tagline: 'Ogni ascolto lascia un solco.',
    /** Optional https PNG/JPEG background photo; '' keeps the plain-color card. */
    image: '',
  },
} as const;

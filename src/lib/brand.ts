// @polsia:user-owned — brand identity. Edit freely. `site.ts` re-exports
// siteName/siteDescription; `manifest.ts` + `opengraph-image.tsx` read `brandVisual`.

export const siteName = 'Solco';
export const siteDescription =
  'Musica, radio dal vivo e podcast gratis in un unico player: classifiche, generi underground e playlist da ascoltare ovunque.';

// PWA + social-share colors, aligned with the light and dark Solco themes.
export const brandVisual = {
  /** PWA browser-UI / status-bar color — usually your background or primary. */
  themeColor: '#000000',
  /** PWA splash + install background. */
  backgroundColor: '#000000',
  /** Social-share (OG/Twitter) image. */
  og: {
    background: '#000000',
    foreground: '#fafafa',
    /** Second line under the site name; '' hides it. */
    tagline: 'Ogni ascolto lascia un solco.',
    /** Optional https PNG/JPEG background photo; '' keeps the plain-color card. */
    image: '',
  },
} as const;

// @polsia:user-owned — brand identity. Edit freely. `site.ts` re-exports
// siteName/siteDescription; `manifest.ts` + `opengraph-image.tsx` read `brandVisual`.

import type { LegalContact } from '@/lib/legal-contact';

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

// Public social channels (external URLs). Kept out of src/lib/nav.ts on purpose:
// nav.ts feeds the sitemap and the internal navigation, which list Solco pages only.
export const socialLinks = {
  telegram: 'https://t.me/solcomusic',
} as const;

/**
 * Chi gestisce Solco e come si contatta: compare in /contatti, nell'informativa privacy, nei
 * termini, nei dati strutturati (Organization) e in security.txt. Compila ownerName, address e
 * taxId per pubblicare l'identità del titolare (fiducia per chi legge e per servizi come
 * ScamAdviser); finché restano '' il sito dice che i dati completi si ottengono via email.
 */
export const legalContact: LegalContact = {
  ownerName: '',
  address: '',
  taxId: '',
  country: 'Italia',
  email: 'solcomusic@polsia.app',
  responseTime: 'di norma entro 2 giorni lavorativi',
};

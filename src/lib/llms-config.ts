// @polsia:user-owned — per-app content for /llms.txt (route.ts is
// framework-owned). Applied only when the deploy is indexable (SEO_INDEXABLE).
//
// The SHAPE (types) is framework-owned in src/lib/llms.ts; here you declare the
// VALUE. The `## Pages` list is generated for you from the public
// routes in src/lib/nav.ts + src/lib/seo-routes.ts — enrich it here with an
// intro, per-page descriptions, extra curated sections, and an `## Optional`
// section. Example:
//
//   export const llmsConfig: LlmsConfig = {
//     intro: 'Acme helps teams ship faster with a hosted CI pipeline.',
//     pageDescriptions: {
//       '/': 'Product overview and sign-up.',
//       '/pricing': 'Plans, limits, and pricing.',
//     },
//     sections: [
//       {
//         title: 'Docs',
//         links: [
//           { label: 'API reference', href: '/docs/api', description: 'REST endpoints.' },
//           { label: 'Status', href: 'https://status.acme.com' }, // external URL, kept as-is
//         ],
//       },
//     ],
//     optional: [{ label: 'Changelog', href: '/changelog' }],
//   };
import { socialLinks } from '@/lib/brand';
import type { LlmsConfig } from '@/lib/llms';

export const llmsConfig: LlmsConfig = {
  intro:
    "Solco è un'app web gratuita per ascoltare musica, radio dal vivo da tutto il mondo e podcast in un unico player, con un piano Premium senza limiti.",
  pageDescriptions: {
    '/': 'Home: classifiche, radio consigliate, podcast e nuove uscite.',
    '/search': 'Cerca brani, artisti, video, radio e podcast.',
    '/generi': 'Generi musicali e playlist, compresi quelli underground.',
    '/radio': 'Migliaia di radio dal vivo, gratis per tutti.',
    '/podcasts': 'Podcast in italiano e da tutto il mondo.',
    '/piani': 'Piani Free e Premium, con prova gratuita di 10 giorni.',
    '/premi': 'Invita amici e ottieni Premium gratis.',
    '/app': 'Installa Solco su Android e iPhone.',
  },
  sections: [
    {
      title: 'Canali ufficiali',
      links: [
        {
          label: 'Canale Telegram di Solco',
          href: socialLinks.telegram,
          description: 'Novità, playlist e anteprime.',
        },
      ],
    },
  ],
};

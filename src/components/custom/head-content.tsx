// @polsia:user-owned — extra <head> rendered by the framework layout (null by default).
// Add <meta>/<link> here (verification, preconnect) — React hoists them. For scripts use
// next/script with the passed `nonce` (CSP-safe). Edit freely.

import { legalContact, socialLinks } from '@/lib/brand';
import { ownerSchema } from '@/lib/legal-contact';
import { SIGNED_IN_HINT_SCRIPT } from '@/lib/signed-in-hint';
import { siteDescription, siteName, siteUrl } from '@/lib/site';

const ORGANIZATION_ID = `${siteUrl}/#organization`;

// Structured data: Google shows the site name and a search box for Solco in results; the
// Organization block tells crawlers and trust services who runs the site and how to reach it
// (contact page, email, official channel; the legal name once brand.ts publishes it).
const structuredData = JSON.stringify([
  {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: siteName,
    url: siteUrl,
    description: siteDescription,
    inLanguage: 'it-IT',
    // schema.org sameAs: Solco's official profiles elsewhere (the public Telegram channel).
    sameAs: [socialLinks.telegram],
    publisher: { '@id': ORGANIZATION_ID },
    potentialAction: {
      '@type': 'SearchAction',
      target: `${siteUrl}/search?q={search_term_string}`,
      'query-input': 'required name=search_term_string',
    },
  },
  {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': ORGANIZATION_ID,
    name: siteName,
    // Chi gestisce Solco: `founder` (persona) o `legalName` (società), dalla stessa fonte di /contatti.
    ...ownerSchema(legalContact),
    url: siteUrl,
    logo: `${siteUrl}/solco-icon-512.png`,
    email: legalContact.email,
    sameAs: [socialLinks.telegram],
    contactPoint: [
      {
        '@type': 'ContactPoint',
        contactType: 'customer support',
        email: legalContact.email,
        url: `${siteUrl}/contatti`,
        availableLanguage: ['it'],
      },
    ],
  },
  {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: siteName,
    url: siteUrl,
    applicationCategory: 'MultimediaApplication',
    operatingSystem: 'Web, Android, iOS',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' },
  },
]).replace(/</g, '\\u003c');

export function HeadContent({ nonce }: { nonce?: string }) {
  // Search Console ownership: set GOOGLE_SITE_VERIFICATION (and/or BING_SITE_VERIFICATION) on the deploy.
  const google = process.env.GOOGLE_SITE_VERIFICATION;
  const bing = process.env.BING_SITE_VERIFICATION;
  return (
    <>
      {google ? <meta name="google-site-verification" content={google} /> : null}
      {bing ? <meta name="msvalidate.01" content={bing} /> : null}
      {/* Prima del primo disegno: segna <html> se questo dispositivo ha una sessione (indizio di
          require-login.tsx), così la landing di "/" non lampeggia a chi ha già fatto l'accesso. */}
      <script
        nonce={nonce}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: script statico, nessun dato esterno.
        dangerouslySetInnerHTML={{ __html: SIGNED_IN_HINT_SCRIPT }}
      />
      <script
        type="application/ld+json"
        nonce={nonce}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static JSON-LD, '<' escaped.
        dangerouslySetInnerHTML={{ __html: structuredData }}
      />
      <link
        rel="preload"
        href="/fonts/space-grotesk/space-grotesk-600-normal-latin.woff2"
        as="font"
        type="font/woff2"
        crossOrigin="anonymous"
      />
      {/* iPhone/iPad: icon and full-screen mode when Solco is added to the Home screen. */}
      <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
      <meta name="apple-mobile-web-app-capable" content="yes" />
      <meta name="mobile-web-app-capable" content="yes" />
      <meta name="apple-mobile-web-app-title" content="Solco" />
      <meta name="apple-mobile-web-app-status-bar-style" content="black" />
    </>
  );
}

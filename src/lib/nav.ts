// @polsia:user-owned — app navigation rendered by SiteNav/SiteFooter and read by
// the sitemap. Edit it as pages are added or removed.
// This list is a convenience, not module registration.

export type NavGroup = 'primary' | 'secondary' | 'footer';

export interface NavItem {
  /** Visible link text. */
  label: string;
  /** App route, e.g. '/' or '/dashboard'. */
  href: string;
  /** Where it renders: top-nav 'primary'/'secondary', or 'footer'. */
  group: NavGroup;
  /** Group `primary` items into a dropdown: items sharing a `menu` value collapse
   *  into one "<menu> ⌄" top-bar slot (e.g. `menu: 'Resources'` on Blog/Docs/
   *  Changelog). Keeps the bar short. Ignored for 'secondary'/'footer'. */
  menu?: string;
  /** When true, render only if a session exists (see site-nav.tsx). */
  requiresAuth?: boolean;
  /** Sort key within a group (ascending); unordered items fall to the end. */
  order?: number;
}

// Keep the bar short: ~3-5 primary slots, group the tail with `menu`, push the
// rest to 'footer' (SiteNav overflows extras into a "More" dropdown). Example:
//   { label: 'Pricing', href: '/pricing', group: 'primary' },
//   { label: 'Blog',    href: '/blog',    group: 'primary', menu: 'Resources' },
//   { label: 'Docs',    href: '/docs',    group: 'primary', menu: 'Resources' },
//   { label: 'Sign in', href: '/login',   group: 'secondary' },
export const navItems: NavItem[] = [
  { label: 'Cerca', href: '/search', group: 'primary', order: 0 },
  { label: 'Bot', href: '/bot', group: 'primary', order: 0 },
  { label: 'Generi', href: '/generi', group: 'primary', order: 1 },
  { label: 'Radio', href: '/radio', group: 'primary', order: 1 },
  { label: 'Podcast', href: '/podcasts', group: 'primary', order: 2 },
  { label: 'Libreria', href: '/library', group: 'primary', order: 3 },
  { label: 'Statistiche', href: '/statistiche', group: 'primary', requiresAuth: true, order: 3 },
  { label: 'Record Pool', href: '/pool', group: 'primary', order: 2 },
  { label: 'Classici', href: '/classici', group: 'primary', order: 2 },
  { label: 'Pubblica', href: '/pubblica', group: 'primary', order: 3 },
  { label: 'Community', href: '/community', group: 'primary', order: 4 },
  { label: 'Piani', href: '/piani', group: 'primary', order: 5 },
  { label: 'Invita amici', href: '/premi', group: 'primary', order: 5 },
  { label: 'Messaggi', href: '/messages', group: 'secondary', requiresAuth: true, order: 0 },
  { label: 'Installa l’app', href: '/app', group: 'primary', order: 6 },
  { label: 'Flashcard', href: '/flashcards', group: 'primary', order: 7 },
  { label: 'Apple Music', href: '/apple-music', group: 'footer', order: -1 },
  { label: 'Stato', href: '/stato', group: 'footer', order: 2 },
  { label: 'Privacy', href: '/privacy', group: 'footer', order: 0 },
  { label: 'Termini', href: '/terms', group: 'footer', order: 1 },
];

/** Schede della barra in basso (mobile), nello stile delle app di streaming. */
export type TabIcon = 'home' | 'search' | 'radio' | 'podcast' | 'library';

export interface TabItem {
  label: string;
  href: string;
  icon: TabIcon;
}

export const tabItems: TabItem[] = [
  { label: 'Home', href: '/', icon: 'home' },
  { label: 'Cerca', href: '/search', icon: 'search' },
  { label: 'Radio', href: '/radio', icon: 'radio' },
  { label: 'Podcast', href: '/podcasts', icon: 'podcast' },
  { label: 'Libreria', href: '/library', icon: 'library' },
];

/** Rotte con una propria navigazione: niente barra delle schede. */
export function hidesTabBar(pathname: string) {
  return (
    pathname === '/stato' ||
    pathname === '/admin' ||
    pathname.startsWith('/admin/') ||
    pathname === '/dashboard' ||
    pathname.startsWith('/dashboard/') ||
    pathname === '/login' ||
    pathname === '/signup'
  );
}

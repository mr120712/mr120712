// @polsia:user-owned — Telegram link in the shared SiteFooter and the mobile menu Sheet.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const route = vi.hoisted(() => ({ pathname: '/' }));

vi.mock('next/navigation', () => ({ usePathname: () => route.pathname }));
vi.mock('@/lib/auth-client', () => ({ useSession: () => ({ data: null }) }));
vi.mock('@/components/custom/auth-nav', () => ({ AuthNav: () => null }));
vi.mock('@/components/custom/snowfall', () => ({ SnowToggle: () => null }));
vi.mock('@/lib/nav', () => ({
  navItems: [
    { label: 'Radio', href: '/radio', group: 'primary' },
    { label: 'Accedi', href: '/login', group: 'secondary' },
    { label: 'Privacy', href: '/privacy', group: 'footer', order: 0 },
    { label: 'Termini', href: '/terms', group: 'footer', order: 1 },
  ],
}));

import { AppTopBar, SiteFooter } from '@/components/custom/site-nav';

const TELEGRAM_URL = 'https://t.me/solcomusic';

function telegramLinks(root: ParentNode): HTMLAnchorElement[] {
  return [...root.querySelectorAll<HTMLAnchorElement>(`a[href="${TELEGRAM_URL}"]`)];
}

/** The single Telegram link inside `root` (fails the test otherwise). */
function onlyTelegramLink(root: ParentNode): HTMLAnchorElement {
  const links = telegramLinks(root);
  expect(links).toHaveLength(1);
  const [link] = links;
  if (!link) throw new Error('Telegram link missing');
  return link;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('SiteFooter', () => {
  it.each(['/radio', '/privacy', '/generi/rock'])('appends the Telegram link on %s', (pathname) => {
    route.pathname = pathname;
    const root = document.createElement('div');
    root.innerHTML = renderToStaticMarkup(<SiteFooter />);
    const nav = root.querySelector('footer nav');
    const link = onlyTelegramLink(root);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.textContent).toBe('Telegram (si apre in una nuova scheda)');
    // After the internal footer items.
    const hrefs = [...(nav?.querySelectorAll('a') ?? [])].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/privacy', '/terms', TELEGRAM_URL]);
  });

  it.each(['/', '/dashboard', '/dashboard/settings', '/admin', '/admin/users'])(
    'keeps the existing guard on %s (no footer at all)',
    (pathname) => {
      route.pathname = pathname;
      expect(renderToStaticMarkup(<SiteFooter />)).toBe('');
    },
  );
});

describe('mobile menu', () => {
  it('ends with the Telegram item and closes the drawer when it is used', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    route.pathname = '/radio';
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    // jsdom cannot open a new tab; keep the click from attempting a navigation.
    const preventNavigation = (event: Event) => event.preventDefault();
    document.addEventListener('click', preventNavigation);
    try {
      await act(async () => root.render(<AppTopBar />));
      // Closed drawer: the item is not in the page yet.
      expect(telegramLinks(document)).toHaveLength(0);

      const trigger = [...container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Apri il menu'),
      );
      expect(trigger).toBeDefined();
      await act(async () => trigger?.click());

      const drawerNav = document.querySelector('nav[aria-label="Navigazione mobile"]');
      expect(drawerNav).not.toBeNull();
      const item = onlyTelegramLink(drawerNav as Element);
      expect(item.textContent).toBe('Canale Telegram (si apre in una nuova scheda)');
      expect(item.getAttribute('target')).toBe('_blank');
      expect(item.getAttribute('rel')).toBe('noopener noreferrer');
      // Bottom of the drawer: after the internal and secondary links.
      const anchors = [...(drawerNav?.querySelectorAll('a') ?? [])];
      expect(anchors.at(-1)).toBe(item);

      await act(async () => item.click());
      expect(document.querySelector('nav[aria-label="Navigazione mobile"]')).toBeNull();
    } finally {
      document.removeEventListener('click', preventNavigation);
      await act(async () => root.unmount());
    }
  });
});

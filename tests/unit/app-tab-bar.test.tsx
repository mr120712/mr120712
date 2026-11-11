// @polsia:user-owned
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const route = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('next/navigation', () => ({ usePathname: () => route.pathname }));

import { AppTabBar, isTabActive } from '@/components/custom/app-tab-bar';

describe('barra delle schede', () => {
  it('mostra Home, Cerca, Radio, Podcast e Libreria con la scheda attiva', () => {
    route.pathname = '/podcasts/123';
    const html = renderToStaticMarkup(<AppTabBar />);
    for (const href of ['/', '/search', '/radio', '/podcasts', '/library']) {
      expect(html).toContain(`href="${href}"`);
    }
    const nav = document.createElement('div');
    nav.innerHTML = html;
    const current = [...nav.querySelectorAll('a[aria-current="page"]')].map((link) =>
      link.getAttribute('href'),
    );
    expect(current).toEqual(['/podcasts']);
  });

  it.each(['/admin', '/admin/users', '/dashboard/crea-musica', '/login', '/signup'])(
    'non compare su %s',
    (pathname) => {
      route.pathname = pathname;
      expect(renderToStaticMarkup(<AppTabBar />)).toBe('');
    },
  );

  it('attiva la Home solo sulla radice', () => {
    expect(isTabActive('/', '/')).toBe(true);
    expect(isTabActive('/', '/search')).toBe(false);
    expect(isTabActive('/library', '/library')).toBe(true);
    expect(isTabActive('/radio', '/radiofonia')).toBe(false);
  });
});

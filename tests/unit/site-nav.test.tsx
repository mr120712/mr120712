import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SiteFooter, SiteNav } from '@/components/custom/site-nav';

const route = vi.hoisted(() => ({ pathname: '/' }));

vi.mock('next/navigation', () => ({ usePathname: () => route.pathname }));
vi.mock('@/lib/nav', () => ({
  navItems: [
    { label: 'Pricing', href: '/pricing', group: 'primary' },
    { label: 'Workspace', href: '/dashboard', group: 'secondary' },
    { label: 'Privacy', href: '/privacy', group: 'footer' },
  ],
}));

function Navigation() {
  return (
    <>
      <SiteNav />
      <main>Page content</main>
      <SiteFooter />
    </>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('marketing navigation alongside routes with their own shell', () => {
  it.each([
    '/',
    '/dashboard',
    '/dashboard/',
    '/dashboard/settings',
    '/dashboard/tickets/123',
    '/admin',
    '/admin/',
    '/admin/users',
    '/admin/service-requests/123',
  ])('omits the marketing header and footer on %s, including the initial render', (pathname) => {
    route.pathname = pathname;
    const html = renderToStaticMarkup(<Navigation />);
    expect(html).not.toContain('<header');
    expect(html).not.toContain('<footer');
    expect(html).toContain('<main>Page content</main>');
  });

  // Auth routes (/login, /signup, …) are deliberately absent from both lists: whether
  // they show the marketing header is a design choice the agent owns, not a contract.
  it.each([
    '/pricing',
    '/dashboard-other',
    '/dashboards',
    '/blog/dashboard',
    '/preview',
    '/preview/relay',
    '/preview-other',
    '/administration',
    '/administrator',
    '/guides/admin',
  ])('keeps the marketing header and footer on %s', (pathname) => {
    route.pathname = pathname;
    const html = renderToStaticMarkup(<Navigation />);
    expect(html).toContain('<header');
    expect(html).toContain('<footer');
    expect(html).toContain('href="/pricing"');
    expect(html).toContain('href="/privacy"');
  });

  it('updates both components when navigating between public, member and admin pages', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      for (const pathname of [
        '/',
        '/dashboard',
        '/dashboard/settings',
        '/preview/relay',
        '/admin',
        '/admin/users',
        '/pricing',
        '/dashboard-other',
      ]) {
        route.pathname = pathname;
        await act(async () => root.render(<Navigation />));
        const isPublicPage = ['/preview/relay', '/pricing', '/dashboard-other'].includes(pathname);
        expect(container.querySelectorAll('header')).toHaveLength(isPublicPage ? 1 : 0);
        expect(container.querySelectorAll('footer')).toHaveLength(isPublicPage ? 1 : 0);
        expect(container.querySelector('main')?.textContent).toBe('Page content');
      }
    } finally {
      await act(async () => root.unmount());
    }
  });
});

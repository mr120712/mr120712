// @polsia:user-owned — Telegram channel link: the three variants, the Home placements,
// the JSON-LD sameAs and the /llms.txt entry.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The Home composes many data-driven client rows; stub them so the test only sees
// the page's own markup (the Telegram card and the footer).
vi.mock('@/components/custom/site-nav', () => ({ AppTopBar: () => null }));
vi.mock('@/components/custom/install-app-banner', () => ({ InstallAppBanner: () => null }));
vi.mock('@/components/custom/music/ai-search-shortcut', () => ({ AiSearchShortcut: () => null }));
vi.mock('@/components/custom/music/audius-section', () => ({ AudiusSection: () => null }));
vi.mock('@/components/custom/music/jamendo-section', () => ({ JamendoSection: () => null }));
vi.mock('@/components/custom/music/local-music-section', () => ({ LocalMusicSection: () => null }));
vi.mock('@/components/custom/music/podcast-home-row', () => ({ PodcastHomeRow: () => null }));
vi.mock('@/components/custom/music/radio-home-row', () => ({ RadioHomeRow: () => null }));
vi.mock('@/components/custom/music/recently-played-row', () => ({
  RecentlyPlayedRow: () => null,
}));
vi.mock('@/components/custom/music/tiktok-clips', () => ({ TikTokClips: () => null }));
vi.mock('@/components/custom/music/youtube-charts', () => ({ YouTubeCharts: () => null }));

import HomePage from '@/app/(setup)/page';
import { HeadContent } from '@/components/custom/head-content';
import { TelegramButton, type TelegramButtonVariant } from '@/components/custom/telegram-button';
import { socialLinks } from '@/lib/brand';
import { llmsConfig } from '@/lib/llms-config';
import { navItems } from '@/lib/nav';

const TELEGRAM_URL = 'https://t.me/solcomusic';
const NEW_TAB = '(si apre in una nuova scheda)';

function parse(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

/** Text-based accessible name of a link (aria-hidden subtrees excluded). */
function accessibleName(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** What a sighted user reads: the name without the screen-reader-only suffix. */
function visibleText(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  for (const hidden of clone.querySelectorAll('[aria-hidden="true"], .sr-only')) hidden.remove();
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
}

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

describe('socialLinks', () => {
  it('points at the public Solco channel', () => {
    expect(socialLinks.telegram).toBe(TELEGRAM_URL);
  });

  it('stays out of the internal navigation and sitemap source', () => {
    expect(navItems.some((item) => item.href.includes('t.me'))).toBe(false);
  });
});

describe('TelegramButton', () => {
  it.each<[TelegramButtonVariant, string, string]>([
    ['card', 'Unisciti al canale', `Unisciti al canale Telegram ${NEW_TAB}`],
    ['link', 'Telegram', `Telegram ${NEW_TAB}`],
    ['menu', 'Canale Telegram', `Canale Telegram ${NEW_TAB}`],
  ])('%s: external link in a new tab with a descriptive name', (variant, visible, name) => {
    const link = onlyTelegramLink(
      parse(renderToStaticMarkup(<TelegramButton variant={variant} />)),
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(visibleText(link)).toBe(visible);
    expect(accessibleName(link)).toBe(name);
    // The visible label leads the accessible name (WCAG 2.5.3 label in name).
    expect(accessibleName(link).startsWith(visible)).toBe(true);
    // Keyboard users get a visible focus indicator.
    expect(link.className).toMatch(/focus-visible:ring/);
    // Icons are decorative.
    for (const svg of link.querySelectorAll('svg')) {
      expect(svg.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('card: a labelled region with title, copy and a white CTA on Telegram blue', () => {
    const root = parse(renderToStaticMarkup(<TelegramButton variant="card" />));
    const section = root.querySelector('section');
    expect(section).not.toBeNull();
    const headingId = section?.getAttribute('aria-labelledby') ?? '';
    const heading = root.querySelector(`#${headingId}`);
    expect(heading?.tagName).toBe('H2');
    expect(heading?.textContent).toBe('Solco su Telegram');
    expect(section?.textContent).toContain('Novità, playlist e anteprime: unisciti al canale.');
    // Telegram blue icon tile with the white paper-plane icon, hidden from AT.
    const tile = section?.querySelector('span[aria-hidden="true"]');
    expect(tile?.className).toContain('bg-[#229ED9]');
    expect(tile?.className).toContain('text-white');
    expect(tile?.querySelector('svg')).not.toBeNull();
    // Text sits on the deeper Telegram blues that keep white copy at AA.
    expect(section?.className).toContain('#1B6FA8');
    expect(section?.className).toContain('#145A8C');
    const cta = onlyTelegramLink(root);
    expect(cta.className).toContain('bg-white');
    expect(cta.className).toContain('focus-visible:ring-white');
  });

  it('link: matches the footer link style', () => {
    const link = onlyTelegramLink(
      parse(renderToStaticMarkup(<TelegramButton variant="link" className="extra" />)),
    );
    expect(link.className).toContain('underline-offset-4');
    expect(link.className).toContain('extra');
  });

  it('menu: full-width ghost item like the other drawer entries', () => {
    const link = onlyTelegramLink(parse(renderToStaticMarkup(<TelegramButton variant="menu" />)));
    expect(link.className).toContain('w-full');
    expect(link.className).toContain('justify-start');
    expect(link.className).toContain('hover:bg-accent');
  });
});

describe('Home', () => {
  it('shows the Telegram card at the end of the feed and a footer link', () => {
    const html = renderToStaticMarkup(<HomePage />);
    const root = parse(html);

    const card = root.querySelector('section[aria-labelledby="telegram-card-heading"]');
    expect(card).not.toBeNull();
    // Last block of the feed, before the footer.
    expect(card?.nextElementSibling).toBeNull();
    expect(card?.parentElement?.nextElementSibling?.tagName).toBe('FOOTER');
    expect(telegramLinks(card as Element)).toHaveLength(1);

    const footerNav = root.querySelector('footer nav[aria-label="Navigazione a piè di pagina"]');
    expect(footerNav).not.toBeNull();
    const footerLink = onlyTelegramLink(footerNav as Element);
    expect(accessibleName(footerLink)).toBe(`Telegram ${NEW_TAB}`);
    // Appended after the existing footer links.
    expect(footerNav?.lastElementChild).toBe(footerLink);
    expect(footerNav?.querySelector('a[href="/terms"]')).not.toBeNull();
  });
});

describe('structured data and llms.txt', () => {
  it('lists the channel in the WebSite JSON-LD sameAs', () => {
    const root = parse(renderToStaticMarkup(<HeadContent nonce="abc" />));
    const script = root.querySelector('script[type="application/ld+json"]');
    expect(script?.getAttribute('nonce')).toBe('abc');
    const data = JSON.parse(script?.textContent ?? '[]') as Array<Record<string, unknown>>;
    const website = data.find((entry) => entry['@type'] === 'WebSite');
    expect(website?.sameAs).toEqual([TELEGRAM_URL]);
  });

  it('points AI crawlers at the channel', () => {
    const links = (llmsConfig.sections ?? []).flatMap((section) => section.links);
    expect(links).toContainEqual(expect.objectContaining({ href: TELEGRAM_URL }));
  });
});

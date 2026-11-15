// @polsia:user-owned — badge «⭐ Premium»: la pillola con la stella (decorativa: il significato è nel
// testo) e la fonte facoltativa, la stellina sul pulsante del profilo solo per gli account Premium
// (con «Premium» nel nome accessibile), l'anello sull'avatar, la riga «Piano» del profilo (Premium
// con la fonte, Free con il link ai piani, caricamento, errore) e il caricamento dello stato.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type SessionState = { data: { user: { id: string; name: string } } | null; isPending: boolean };

const mocks = vi.hoisted(() => ({
  session: { data: null, isPending: false } as SessionState,
  player: null as { premium: boolean | null } | null,
  apiFetch: vi.fn(),
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/search' }));
vi.mock('@/lib/auth-client', () => ({ useSession: () => mocks.session }));
vi.mock('@/components/custom/music/music-player', () => ({
  useOptionalMusicPlayer: () => mocks.player,
}));
vi.mock('@/lib/music/player-session', () => ({
  SIGN_OUT_FAILED_MESSAGE: 'Uscita non riuscita.',
  signOutAndStopMusic: vi.fn(async () => true),
}));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));

import { AccountPlanRow } from '@/components/custom/account-plan-row';
import { AuthNav } from '@/components/custom/auth-nav';
import { PremiumAvatarRing, PremiumBadge, PremiumStarDot } from '@/components/custom/premium-badge';
import { type AccountPremiumState, useAccountPremium } from '@/hooks/use-account-premium';

const roots: Array<ReturnType<typeof createRoot>> = [];

function render(node: React.ReactNode) {
  const container = document.createElement('div');
  const root = createRoot(container);
  roots.push(root);
  return { container, root, update: (next: React.ReactNode) => root.render(next), node };
}

async function mount(node: React.ReactNode) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const view = render(node);
  await act(async () => view.root.render(node));
  await act(async () => {
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
  });
  return view;
}

beforeEach(() => {
  mocks.session = { data: { user: { id: 'u1', name: 'Ada' } }, isPending: false };
  mocks.player = { premium: true };
  mocks.apiFetch.mockReset();
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('PremiumBadge', () => {
  it('«Premium» con la stella decorativa', async () => {
    const { container } = await mount(<PremiumBadge />);
    const badge = container.querySelector('[data-premium-badge]');
    expect(badge?.textContent).toBe('Premium');
    const star = badge?.querySelector('svg');
    expect(star?.getAttribute('aria-hidden')).toBe('true');
  });

  it('la fonte dopo un separatore nascosto ai lettori di schermo', async () => {
    const { container } = await mount(<PremiumBadge size="sm" detail="Illimitato" />);
    const badge = container.querySelector('[data-premium-badge]');
    expect(badge?.textContent).toBe('Premium · Illimitato');
    const hidden = [...(badge?.querySelectorAll('[aria-hidden="true"]') ?? [])].map(
      (node) => node.textContent,
    );
    expect(hidden).toContain(' · ');
  });

  it('stellina e anello: decorativi, la stellina solo con il Premium', () => {
    expect(renderToStaticMarkup(<PremiumStarDot />)).toContain('aria-hidden="true"');
    const free = renderToStaticMarkup(
      <PremiumAvatarRing premium={false}>
        <span>A</span>
      </PremiumAvatarRing>,
    );
    const premium = renderToStaticMarkup(
      <PremiumAvatarRing premium>
        <span>A</span>
      </PremiumAvatarRing>,
    );
    expect(free).not.toContain('data-premium-star');
    expect(premium).toContain('data-premium-star');
  });
});

describe('stellina sul pulsante del profilo', () => {
  it('account Premium: stellina e «Premium» nel nome accessibile', async () => {
    const { container } = await mount(<AuthNav />);
    const link = container.querySelector('a[href="/profile"]');
    expect(link?.getAttribute('aria-label')).toBe('Profilo, account Premium');
    expect(link?.querySelector('[data-premium-star]')).not.toBeNull();
  });

  it('account Free, Premium non ancora noto o fuori dal player: nessuna stellina', async () => {
    for (const player of [{ premium: false }, { premium: null }, null]) {
      mocks.player = player;
      const { container } = await mount(<AuthNav />);
      const link = container.querySelector('a[href="/profile"]');
      expect(link?.getAttribute('aria-label')).toBe('Profilo');
      expect(link?.querySelector('[data-premium-star]')).toBeNull();
    }
  });

  it('ospite: nessun pulsante del profilo', async () => {
    mocks.session = { data: null, isPending: false };
    const { container } = await mount(<AuthNav />);
    expect(container.querySelector('a[href="/profile"]')).toBeNull();
    expect(container.querySelector('[data-premium-star]')).toBeNull();
  });
});

describe('riga «Piano» del profilo', () => {
  const row = (state: AccountPremiumState) =>
    renderToStaticMarkup(<AccountPlanRow state={state} />);

  it('Premium: badge con la fonte e la spiegazione', () => {
    const html = row({ status: 'ready', premium: true, source: 'unlimited' });
    expect(html).toContain('data-premium-badge');
    expect(html).toContain('Illimitato');
    expect(html).toContain('Premium senza scadenza.');
    expect(html).not.toContain('/piani');
  });

  it('Free: «Free» e il link ai piani, nessun badge', () => {
    const html = row({ status: 'ready', premium: false, source: null });
    expect(html).toContain('Free');
    expect(html).toContain('href="/piani"');
    expect(html).toContain('Passa a Premium');
    expect(html).not.toContain('data-premium-badge');
  });

  it('caricamento e errore', () => {
    expect(row({ status: 'loading' })).toContain('Caricamento del piano…');
    expect(row({ status: 'error' })).toContain('non disponibile');
  });
});

describe('useAccountPremium', () => {
  function Probe({ userId }: { userId: string | null }) {
    const state = useAccountPremium(userId);
    return <output>{JSON.stringify(state)}</output>;
  }

  it('legge Premium e fonte del proprio account', async () => {
    mocks.apiFetch.mockResolvedValue({ premium: true, source: 'subscription' });
    const { container } = await mount(<Probe userId="u1" />);
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      '/api/account/premium',
      expect.objectContaining({ schema: expect.anything() }),
    );
    expect(JSON.parse(container.textContent ?? '{}')).toEqual({
      status: 'ready',
      premium: true,
      source: 'subscription',
    });
  });

  it('senza account nessuna richiesta; un errore resta un errore', async () => {
    const guest = await mount(<Probe userId={null} />);
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(JSON.parse(guest.container.textContent ?? '{}')).toEqual({ status: 'loading' });

    mocks.apiFetch.mockRejectedValue(new Error('offline'));
    const failed = await mount(<Probe userId="u2" />);
    expect(JSON.parse(failed.container.textContent ?? '{}')).toEqual({ status: 'error' });
  });

  it('cambio account: rilegge per il nuovo account', async () => {
    mocks.apiFetch.mockResolvedValueOnce({ premium: false, source: null });
    const view = await mount(<Probe userId="u1" />);
    expect(JSON.parse(view.container.textContent ?? '{}')).toMatchObject({ premium: false });
    mocks.apiFetch.mockResolvedValueOnce({ premium: true, source: 'rewards' });
    await act(async () => view.update(<Probe userId="u3" />));
    await act(async () => {
      for (let index = 0; index < 4; index += 1) await Promise.resolve();
    });
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(view.container.textContent ?? '{}')).toEqual({
      status: 'ready',
      premium: true,
      source: 'rewards',
    });
  });
});

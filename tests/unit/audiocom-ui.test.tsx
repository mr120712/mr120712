// @polsia:user-owned — audio.com nella Cerca unificata (client): audio.com chiesto SOLO per le
// ricerche complete (link di ricerca, invio) e mai mentre si digita; righe con copertina, titolo,
// autore, distintivo «audio.com», licenza (link al testo CC) e link al brano; un brano CC BY suona
// nel player di Solco con l'attribuzione, uno «Tutti i diritti riservati» NO: «Ascolta su
// audio.com» apre il player ufficiale (solo iframe, mai embed.js), con il focus sul titolo (mai
// nell'iframe), Esc che chiude, «Chiudi» in italiano e scorrimento su schermi bassi; le cover CC
// solo nel player di audio.com; nota se audio.com non risponde, niente promessa se non è collegato.
// Più: CSP con frame-src https://audio.com e il paragrafo della privacy.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  playTrack: vi.fn(),
  togglePlayback: vi.fn(),
  replace: vi.fn(),
  status: 'idle' as string,
}));

vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/search',
  useRouter: () => ({ replace: mocks.replace }),
}));
vi.mock('next/link', () => ({
  // biome-ignore lint/suspicious/noExplicitAny: lo stub inoltra ciò che passa il componente.
  default: ({ href, children, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/components/custom/music/music-player', () => ({
  useMusicPlayer: () => ({
    currentTrack: null,
    status: mocks.status,
    playTrack: mocks.playTrack,
    togglePlayback: mocks.togglePlayback,
  }),
  trackStreamPath: (track: { streamUrl?: string | null }) => track.streamUrl ?? null,
}));
vi.mock('@/components/custom/music/fallback-art', () => ({
  FallbackArt: ({ src }: { src: string | null }) => <span data-art={src ?? ''} />,
}));
vi.mock('@/components/custom/music/ai-music-search', () => ({ AiMusicSearch: () => null }));
vi.mock('@/components/custom/music/listen-in-solco', () => ({ ListenInSolco: () => null }));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import PrivacyPage from '@/app/(custom)/privacy/page';
import { UnifiedSearchResults } from '@/components/custom/music/unified-search-results';
import { buildCsp } from '@/lib/csp';
import { cspExtraSources } from '../../next.user-config';

const ccTrack = {
  id: '111',
  title: 'Alba sul mare',
  authorName: 'Anna Rossi',
  pageUrl: 'https://audio.com/anna-rossi/audio/alba-sul-mare',
  imageUrl: 'https://s3.audio.com/images/111.jpg',
  streamUrl: 'https://s3.audio.com/audio/111.mp3',
  durationSeconds: 125,
  category: 'music',
  license: 'cc-by',
};
const arrTrack = {
  id: '222',
  title: 'Alba privata',
  authorName: 'Marco Bianchi',
  pageUrl: 'https://audio.com/marco/audio/alba-privata',
  imageUrl: null,
  streamUrl: null,
  durationSeconds: null,
  category: 'cover',
  license: 'arr',
};

const response = {
  query: 'alba',
  youtubeRequested: false,
  results: [
    { kind: 'audiocom', key: 'audiocom:111', score: 70, track: ccTrack, youtubeAlternative: null },
    { kind: 'audiocom', key: 'audiocom:222', score: 70, track: arrTrack, youtubeAlternative: null },
  ],
  sources: {
    audius: { status: 'empty', tracks: [], artists: [], playlists: [], albums: [] },
    youtube: { status: 'skipped', videos: [] },
    radio: { status: 'empty', stations: [] },
    podcasts: { status: 'empty', podcasts: [] },
    audiocom: { status: 'results', tracks: [ccTrack, arrTrack] },
  },
};

const roots: Array<ReturnType<typeof createRoot>> = [];

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(initialQuery: string) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<UnifiedSearchResults initialQuery={initialQuery} />));
  await flush();
  return container;
}

function urlCalls() {
  return mocks.apiFetch.mock.calls.map((call) => String(call[0]));
}

function rowFor(container: HTMLElement, title: string) {
  return [...container.querySelectorAll('ol li')].find((li) => li.textContent?.includes(title));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.apiFetch.mockReset().mockResolvedValue(response);
  mocks.playTrack.mockReset();
  mocks.togglePlayback.mockReset();
  mocks.replace.mockReset();
  mocks.status = 'idle';
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('quando si chiede audio.com', () => {
  it('link di ricerca (?q=…): sì, con audiocom=1', async () => {
    await mount('alba');
    expect(urlCalls()).toHaveLength(1);
    expect(urlCalls()[0]).toContain('audiocom=1');
    expect(urlCalls()[0]).not.toContain('youtubeConsent');
  });

  it('mentre si digita: no; all’invio: sì (insieme a YouTube, una sola richiesta)', async () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<UnifiedSearchResults initialQuery="" />));
    const input = container.querySelector<HTMLInputElement>('#unified-query');
    if (!input) throw new Error('input assente');
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      setValue?.call(input, 'alba');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(urlCalls()).toHaveLength(1);
    expect(urlCalls()[0]).not.toContain('audiocom=1');

    await act(async () => {
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(urlCalls()).toHaveLength(2);
    expect(urlCalls()[1]).toContain('audiocom=1');
    expect(urlCalls()[1]).toContain('youtubeConsent=accepted');
  });
});

describe('righe di audio.com', () => {
  it('CC BY: copertina, titolo, autore, distintivi, link alla licenza e al brano; suona in Solco', async () => {
    const container = await mount('alba');
    const row = rowFor(container, 'Alba sul mare');
    if (!row) throw new Error('riga assente');
    expect(row.querySelector('[data-art]')?.getAttribute('data-art')).toBe(ccTrack.imageUrl);
    expect(row.textContent).toContain('audio.com');
    expect(row.textContent).toContain('Anna Rossi · 2:05');
    const license = row.querySelector<HTMLAnchorElement>('a[title="Licenza CC BY 4.0"]');
    expect(license?.textContent).toContain('CC BY');
    expect(license?.href).toBe('https://creativecommons.org/licenses/by/4.0/deed.it');
    const page = [...row.querySelectorAll('a')].find((a) =>
      a.textContent?.includes('su audio.com'),
    );
    expect(page?.getAttribute('href')).toBe(ccTrack.pageUrl);
    expect(page?.getAttribute('rel')).toContain('noopener');
    // Riproducibile: niente player di audio.com, sì il pulsante di Solco.
    expect(row.textContent).not.toContain('Ascolta su audio.com');

    const play = row.querySelector<HTMLButtonElement>(
      'button[aria-label="Riproduci Alba sul mare di Anna Rossi"]',
    );
    if (!play) throw new Error('pulsante assente');
    await act(async () => play.click());
    expect(mocks.playTrack).toHaveBeenCalledTimes(1);
    const [track, path, queue] = mocks.playTrack.mock.calls[0] ?? [];
    // Id proprio di audio.com (accesso e conteggio Free nel player), stream diretto come i file
    // pubblici.
    expect(track).toMatchObject({
      qualifiedId: 'audiocom:111',
      playbackMode: 'upload',
      artistName: 'Anna Rossi',
      sourceLabel: 'audio.com · CC BY 4.0',
      sourceUrl: ccTrack.pageUrl,
    });
    expect(path).toBe(ccTrack.streamUrl);
    // In coda solo i brani riproducibili (mai quello «Tutti i diritti riservati»).
    expect((queue as Array<{ qualifiedId: string }>).map((item) => item.qualifiedId)).toEqual([
      'audiocom:111',
    ]);
  });

  it('Tutti i diritti riservati: mai nel player di Solco; «Ascolta su audio.com» apre il player ufficiale', async () => {
    mocks.status = 'playing';
    const container = await mount('alba');
    const row = rowFor(container, 'Alba privata');
    if (!row) throw new Error('riga assente');
    expect(row.textContent).toContain('Tutti i diritti riservati');
    // Nessun pulsante di riproduzione per questa riga.
    expect(row.querySelector('button[aria-label^="Riproduci"]')).toBeNull();
    expect(row.querySelector('a[href*="creativecommons.org"]')).toBeNull();
    expect(document.querySelector('iframe')).toBeNull();

    const trigger = [...row.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Ascolta su audio.com'),
    );
    if (!trigger) throw new Error('pulsante assente');
    await act(async () => trigger.click());
    await flush();

    const frame = document.querySelector('iframe');
    expect(frame?.getAttribute('src')).toBe('https://audio.com/embed/v2/audio/222?theme=dark');
    expect(frame?.getAttribute('title')).toBe('Player di audio.com: Alba privata di Marco Bianchi');
    expect(frame?.getAttribute('loading')).toBe('lazy');
    expect(frame?.getAttribute('sandbox')).toBe(
      'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox',
    );
    // Mai lo script embed.js di audio.com.
    expect(document.querySelector('script[src*="audio.com"]')).toBeNull();
    expect(document.body.innerHTML).not.toContain('embed.js');
    const dialog = document.querySelector('[role="dialog"]');
    const pageLink = [...(dialog?.querySelectorAll('a') ?? [])].find((a) =>
      a.textContent?.includes('Apri la pagina su audio.com'),
    );
    expect(pageLink?.getAttribute('href')).toBe(arrTrack.pageUrl);
    // Il player di Solco in riproduzione si mette in pausa; nessun avvio nel player di Solco.
    expect(mocks.togglePlayback).toHaveBeenCalledTimes(1);
    expect(mocks.playTrack).not.toHaveBeenCalled();
  });
});

async function openEmbed(container: HTMLElement, title: string) {
  const row = rowFor(container, title);
  if (!row) throw new Error('riga assente');
  const trigger = [...row.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Ascolta su audio.com'),
  );
  if (!trigger) throw new Error('pulsante assente');
  await act(async () => trigger.click());
  await flush();
  return row;
}

describe('finestra del player ufficiale: accessibilità', () => {
  it('all’apertura il focus va sul titolo (mai nell’iframe di audio.com) ed Esc chiude', async () => {
    const container = await mount('alba');
    await openEmbed(container, 'Alba privata');
    const dialog = document.querySelector('[role="dialog"]');
    const frame = document.querySelector('iframe');
    expect(frame).not.toBeNull();
    expect(document.activeElement).not.toBe(frame);
    expect(document.activeElement?.tagName).toBe('H2');
    expect(document.activeElement?.textContent).toBe('Alba privata');
    expect(dialog?.contains(document.activeElement)).toBe(true);
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('il pulsante di chiusura è annunciato in italiano («Chiudi»)', async () => {
    const container = await mount('alba');
    await openEmbed(container, 'Alba privata');
    const dialog = document.querySelector('[role="dialog"]');
    const labels = [...(dialog?.querySelectorAll('button') ?? [])].map((b) => b.textContent);
    expect(labels).toContain('Chiudi');
    expect(labels).not.toContain('Close');
  });

  it('su schermi bassi la finestra scorre (titolo e chiusura restano raggiungibili)', () => {
    const css = readFileSync(
      join(process.cwd(), 'src/components/custom/music/audiocom-attribution.module.css'),
      'utf8',
    );
    const dialogRule = css.match(/\.dialog \{[^}]*\}/)?.[0] ?? '';
    expect(dialogRule).toContain('max-height: calc(100dvh - 32px)');
    expect(dialogRule).toContain('overflow-y: auto');
  });
});

describe('cover e stato di audio.com nella Cerca', () => {
  const coverTrack = {
    ...ccTrack,
    id: '333',
    title: 'Yesterday (cover)',
    pageUrl: 'https://audio.com/anna-rossi/audio/yesterday-cover',
    streamUrl: null,
    category: 'cover',
    license: 'cc-by',
  };

  it('una cover CC BY non suona in Solco: «Ascolta su audio.com» con il motivo', async () => {
    mocks.apiFetch.mockResolvedValue({
      ...response,
      results: [
        {
          kind: 'audiocom',
          key: 'audiocom:333',
          score: 40,
          track: coverTrack,
          youtubeAlternative: null,
        },
      ],
      sources: { ...response.sources, audiocom: { status: 'results', tracks: [coverTrack] } },
    });
    const container = await mount('alba');
    const row = await openEmbed(container, 'Yesterday (cover)');
    expect(row.querySelector('button[aria-label^="Riproduci"]')).toBeNull();
    // L'attribuzione della licenza resta visibile.
    expect(row.querySelector('a[href*="creativecommons.org/licenses/by/4.0"]')).not.toBeNull();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('È una cover');
    expect(document.querySelector('iframe')?.getAttribute('src')).toBe(
      'https://audio.com/embed/v2/audio/333?theme=dark',
    );
  });

  it('audio.com "unavailable": una breve nota visibile e annunciata', async () => {
    mocks.apiFetch.mockResolvedValue({
      ...response,
      results: [],
      sources: { ...response.sources, audiocom: { status: 'unavailable', tracks: [] } },
    });
    const container = await mount('alba');
    const note = 'audio.com non risponde in questo momento: riprova tra poco.';
    expect([...container.querySelectorAll('p')].some((p) => p.textContent === note)).toBe(true);
    expect(container.querySelector('output')?.textContent).toContain(note);
  });

  it('audio.com "disconnected": il suggerimento non promette audio.com; con risultati sì', async () => {
    const hint = (container: HTMLElement) =>
      [...container.querySelectorAll('p')].find((p) => p.textContent?.includes('Mentre scrivi'))
        ?.textContent ?? '';
    const connected = await mount('alba');
    expect(hint(connected)).toContain('e audio.com');
    expect(connected.textContent).not.toContain('audio.com non risponde');

    mocks.apiFetch.mockResolvedValue({
      ...response,
      results: [],
      sources: { ...response.sources, audiocom: { status: 'disconnected', tracks: [] } },
    });
    const disconnected = await mount('alba');
    expect(hint(disconnected)).not.toContain('audio.com');
    expect(hint(disconnected)).toContain('(la query raggiunge Google).');
    expect(disconnected.textContent).not.toContain('audio.com non risponde');
  });
});

describe('CSP e privacy', () => {
  it('frame-src ammette https://audio.com (solo frame: script-src resta rigoroso)', () => {
    expect(cspExtraSources.frameSrc).toContain('https://audio.com');
    const csp = buildCsp('n', false, '', cspExtraSources);
    const directive = (name: string) =>
      csp
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${name} `)) ?? '';
    expect(directive('frame-src')).toContain('https://audio.com');
    expect(directive('script-src')).not.toContain('audio.com');
  });

  it('la privacy spiega che il testo cercato va ad audio.com senza dati personali', () => {
    const root = document.createElement('div');
    root.innerHTML = renderToStaticMarkup(<PrivacyPage />);
    const content = (root.textContent ?? '').replace(/\s+/g, ' ');
    expect(content).toContain('Ricerca su audio.com:');
    expect(content).toContain('il testo cercato viene inviato dal server di Solco ad audio.com');
    expect(content).toContain('nessun dato personale');
  });
});

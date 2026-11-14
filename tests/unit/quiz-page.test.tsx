// @polsia:user-owned — pagina pubblica del quiz musicale (/quiz): metadati con la domanda e mai la
// risposta, la stessa scheda di anteprima del menu «Sfida un amico», carta che si gira senza
// JavaScript (<details>) con la risposta nascosta finché è chiusa, link di ascolto e di sfida;
// senza JavaScript nessun pulsante morto (link diretti ai social), og:url canonico.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import QuizPage, { generateMetadata } from '@/app/(custom)/quiz/page';
import { SongQuizCard } from '@/components/custom/music/song-quiz-card';
import { searchParamsRecord, songShareUrl } from '@/lib/business/social-share';
import {
  QUIZ_CREATE_PATH,
  QUIZ_DESCRIPTION,
  QUIZ_GENERIC_TITLE,
  quizShareImagePath,
  songQuizFromParams,
  songQuizUrl,
} from '@/lib/business/song-quiz';
import { linkPreviewFor } from '@/lib/security/uam-preview';

const BASE = 'https://www.solcomusic.online';
const TRACK_ID = 'J7Xb000';

function paramsOf(url: string | null) {
  return Object.fromEntries(new URL(String(url)).searchParams);
}

async function metadataFor(params: Record<string, string | string[] | undefined>) {
  return generateMetadata({ searchParams: Promise.resolve(params) });
}

async function renderPage(params: Record<string, string | string[] | undefined>) {
  const element = await QuizPage({ searchParams: Promise.resolve(params) });
  const html = renderToStaticMarkup(element);
  return { html, doc: new DOMParser().parseFromString(html, 'text/html') };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('metadati di /quiz', () => {
  it('la domanda come titolo, immagine JPEG canonica, noindex, nessuna traccia dell’artista', async () => {
    const link = songQuizUrl({ title: 'Notte chiara', artist: 'Artista Misterioso' }, BASE);
    const metadata = await metadataFor(paramsOf(link));
    expect(metadata.title).toBe('Quiz: chi interpreta «Notte chiara»?');
    expect(metadata.description).toBe(QUIZ_DESCRIPTION);
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.openGraph).toMatchObject({
      title: 'Quiz: chi interpreta «Notte chiara»?',
      description: QUIZ_DESCRIPTION,
      images: [
        {
          url: '/quiz/anteprima.jpg?t=Notte%20chiara',
          type: 'image/jpeg',
          width: 1200,
          height: 630,
          alt: 'Quiz: chi interpreta «Notte chiara»?',
        },
      ],
    });
    expect(metadata.twitter).toMatchObject({
      card: 'summary_large_image',
      title: 'Quiz: chi interpreta «Notte chiara»?',
      images: ['/quiz/anteprima.jpg?t=Notte%20chiara'],
    });
    const all = JSON.stringify(metadata).toLowerCase();
    expect(all).not.toContain('misterioso');
    expect(all).not.toContain('artista%20misterioso');
  });

  it('og:url: il percorso canonico del quiz, lo stesso della paginetta in modalità attacco', async () => {
    const link = String(
      songQuizUrl({ title: 'Luci basse', artist: 'Artista Audius', audiusId: TRACK_ID }, BASE),
    );
    // Parametri in più (es. fbclid) non entrano nell'og:url.
    const metadata = await metadataFor({ ...paramsOf(link), fbclid: 'abc' });
    const url = (metadata.openGraph as { url?: string } | undefined)?.url;
    expect(url).toBe(link.slice(BASE.length));
    expect(linkPreviewFor(new URL(`${link}&fbclid=abc`), BASE).url).toBe(link);
    const generic = await metadataFor({ c: 'rotto' });
    expect((generic.openGraph as { url?: string } | undefined)?.url).toBe('/quiz');
    expect(linkPreviewFor(new URL(`${BASE}/quiz?c=rotto`), BASE).url).toBe(`${BASE}/quiz`);
  });

  it('brano Audius: l’immagine porta solo l’id', async () => {
    const link = songQuizUrl(
      { title: 'Luci basse', artist: 'Artista Audius', audiusId: TRACK_ID },
      BASE,
    );
    const metadata = await metadataFor(paramsOf(link));
    expect(JSON.stringify(metadata.openGraph)).toContain(
      JSON.stringify(`/quiz/anteprima.jpg?au=${TRACK_ID}`),
    );
    expect(JSON.stringify(metadata)).not.toContain('Artista Audius');
  });

  it('link senza un quiz valido: i metadati generici del quiz', async () => {
    for (const params of [{}, { c: 'rotto' }, { c: '1.!!!' }, { t: 'Solo titolo', a: 'Mina' }]) {
      const metadata = await metadataFor(params);
      // Nel <title> il layout aggiunge « · Solco»; nelle anteprime il titolo completo.
      expect(metadata.title).toBe('Quiz musicale');
      expect(metadata.openGraph?.title).toBe(QUIZ_GENERIC_TITLE);
      expect(metadata.twitter?.title).toBe(QUIZ_GENERIC_TITLE);
      expect(metadata.robots).toEqual({ index: false, follow: true });
      expect(JSON.stringify(metadata.openGraph)).toContain('"/quiz/anteprima.jpg"');
      expect(JSON.stringify(metadata)).not.toContain('Mina');
    }
  });

  it('l’immagine allegata da «Sfida un amico» è identica all’og:image della pagina', async () => {
    const cases: Array<[string, string, string | null]> = [
      ['Albachiara', 'Vasco Rossi', null],
      ['Luci basse', 'Artista Audius', TRACK_ID],
      ['  Help!  (Remastered) ', 'The   Beatles', null],
      [`${'Ж'.repeat(119)}😀😀`, 'Ω'.repeat(90), null],
      ['Brano www.evil.example', 'Artista', null],
    ];
    for (const [title, artist, audiusId] of cases) {
      const link = songQuizUrl({ title, artist, audiusId }, BASE);
      const metadata = await metadataFor(paramsOf(link));
      const images = (metadata.openGraph as { images?: Array<{ url: string }> } | undefined)
        ?.images;
      expect(images?.[0]?.url, title).toBe(quizShareImagePath(String(link)));
    }
  });
});

describe('la carta del quiz', () => {
  it('la domanda si vede subito; la risposta è dentro un <details> chiuso', async () => {
    const link = songQuizUrl({ title: 'Notte chiara', artist: 'Artista Misterioso' }, BASE);
    const { doc } = await renderPage(paramsOf(link));
    const details = doc.querySelector('details');
    expect(details).not.toBeNull();
    expect(details?.hasAttribute('open')).toBe(false);
    const summary = details?.querySelector(':scope > summary');
    expect(summary?.textContent).toContain('Chi interpreta «Notte chiara»?');
    expect(summary?.textContent).toContain('Gira la carta');
    expect(summary?.textContent).not.toContain('Misterioso');
    // Fuori dal <details> nessuna traccia della risposta (titolo, intestazione, testi).
    const outside = doc.body.cloneNode(true) as HTMLElement;
    outside.querySelector('details')?.remove();
    expect(outside.innerHTML).not.toContain('Misterioso');
    expect(doc.querySelector('h1')?.textContent).toBe('Quiz musicale');
    // Il retro: l'artista, dopo il <summary>.
    const back = [...(details?.children ?? [])].filter((node) => node.tagName !== 'SUMMARY');
    expect(back.map((node) => node.textContent).join(' ')).toContain('Artista Misterioso');
  });

  it('sul retro: «Ascolta su Solco», link diretti ai social senza JavaScript, «Crea la tua sfida»', async () => {
    const link = songQuizUrl(
      { title: 'Luci basse', artist: 'Artista Audius', audiusId: TRACK_ID },
      BASE,
    );
    const { doc, html } = await renderPage(paramsOf(link));
    const back = doc.querySelector('details > summary + *');
    const anchors = [...(back?.querySelectorAll('a') ?? [])];
    const listen = anchors.find((anchor) => anchor.textContent?.includes('Ascolta su Solco'));
    const own = anchors.find((anchor) => anchor.textContent?.includes('Crea la tua sfida'));
    // La ricerca del brano su questo stesso sito (percorso relativo), con il suo id Audius.
    const search = new URL(songShareUrl('Luci basse', 'Artista Audius', BASE, TRACK_ID));
    expect(listen?.getAttribute('href')).toBe(`${search.pathname}${search.search}`);
    expect(listen?.getAttribute('href')?.startsWith('/search?q=')).toBe(true);
    // «Crea la tua sfida» apre il mazzo dei tuoi ascolti, l'unico con «Sfida un amico».
    expect(own?.getAttribute('href')).toBe(QUIZ_CREATE_PATH);
    expect(QUIZ_CREATE_PATH).toBe('/flashcards?mazzo=ascolti');
    // Prima di JavaScript nessun pulsante che non fa nulla: al suo posto, in <noscript>, i link
    // diretti ai social con lo stesso quiz e il testo senza la risposta.
    expect(back?.querySelector('button')).toBeNull();
    const fallback = /<noscript>([\s\S]*)<\/noscript>/.exec(html)?.[1] ?? '';
    const fallbackDoc = new DOMParser().parseFromString(fallback, 'text/html');
    const social = [...fallbackDoc.querySelectorAll('a')].map((anchor) => anchor.href);
    expect(social.length).toBe(5);
    const telegram = new URL(social.find((href) => href.startsWith('https://t.me/')) ?? '');
    expect(telegram.searchParams.get('url')).toBe(link);
    expect(telegram.searchParams.get('text')).toBe(
      'Sai chi interpreta «Luci basse»? Gira la carta su Solco.',
    );
    for (const href of social) expect(decodeURIComponent(href)).not.toContain('Artista Audius');
  });

  it('con JavaScript: «Sfida un amico» compare dopo l’idratazione, senza errori', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const quiz = songQuizFromParams(
      searchParamsRecord(
        new URL(String(songQuizUrl({ title: 'Notte', artist: 'Mina' }, BASE))).searchParams,
      ),
    );
    const container = document.createElement('div');
    container.innerHTML = renderToString(<SongQuizCard quiz={quiz} />);
    document.body.append(container);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const root = await act(async () =>
      hydrateRoot(container, <SongQuizCard quiz={quiz} />, {
        onRecoverableError: (error) => {
          throw error;
        },
      }),
    );
    const share = container.querySelector('button[aria-label="Sfida un amico con questo quiz"]');
    expect(share?.textContent).toContain('Sfida un amico');
    expect(container.querySelector('noscript')).toBeNull();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
    await act(async () => root.unmount());
  });

  it('link non valido: un messaggio gentile e il link alle flashcard, nessuna carta', async () => {
    for (const params of [{}, { c: '1.QnJhbm8' }, { c: 'x'.repeat(5000) }]) {
      const { doc } = await renderPage(params);
      expect(doc.querySelector('details')).toBeNull();
      expect(doc.body.textContent).toContain('Questo quiz non si apre');
      const link = doc.querySelector('a[href="/flashcards"]');
      expect(link?.textContent).toContain('Gioca con le flashcard');
    }
  });

  it('la rotazione solo se il movimento è consentito', () => {
    const css = readFileSync(
      join(process.cwd(), 'src/components/custom/music/song-quiz-card.module.css'),
      'utf8',
    );
    const start = css.indexOf('@media (prefers-reduced-motion: no-preference)');
    expect(start).toBeGreaterThan(-1);
    const end = css.indexOf('@keyframes');
    const outside = css.slice(0, start) + css.slice(end);
    expect(outside).not.toMatch(/\banimation\s*:/);
    expect(outside).not.toMatch(/\btransition\s*:/);
    expect(css.slice(start, end)).toMatch(/\banimation\s*:/);
  });
});

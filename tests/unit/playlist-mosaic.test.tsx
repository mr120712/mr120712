// @polsia:user-owned — copertina a mosaico delle playlist: quante copertine, quali, ripieghi.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PlaylistMosaic,
  playlistMosaicCovers,
  playlistMosaicLayout,
} from '@/components/custom/music/playlist-mosaic';

const roots: Array<ReturnType<typeof createRoot>> = [];

function cover(letter: string) {
  return `https://audius.co/content/${letter}/480x480.jpg`;
}

function items(...artwork: Array<string | null>) {
  return artwork.map((artworkUrl) => ({ artworkUrl }));
}

async function render(name: string, list: ReadonlyArray<{ artworkUrl?: string | null }>) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<PlaylistMosaic name={name} items={list} />));
  const mosaic = container.firstElementChild as HTMLElement;
  return { container, mosaic, images: () => [...container.querySelectorAll('img')] };
}

async function failToLoad(image: HTMLImageElement | undefined) {
  if (!image) throw new Error('Immagine non trovata.');
  await act(async () => {
    image.dispatchEvent(new Event('error'));
  });
}

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('scelta delle copertine', () => {
  it('prende le prime 4 copertine diverse nell’ordine della playlist', () => {
    const list = items(cover('a'), null, cover('a'), cover('b'), '', cover('c'), cover('d'));
    expect(playlistMosaicCovers(list)).toEqual([cover('a'), cover('b'), cover('c'), cover('d')]);
    expect(playlistMosaicCovers([...list, { artworkUrl: cover('e') }])).toHaveLength(4);
    expect(playlistMosaicCovers([{}, { artworkUrl: undefined }])).toEqual([]);
  });

  it('mosaico con 4 copertine diverse, una sola con 1-3, iniziale senza copertine', () => {
    expect(playlistMosaicLayout([])).toBe('fallback');
    expect(playlistMosaicLayout([cover('a')])).toBe('single');
    expect(playlistMosaicLayout([cover('a'), cover('b'), cover('c')])).toBe('single');
    expect(playlistMosaicLayout([cover('a'), cover('b'), cover('c'), cover('d')])).toBe('grid');
  });
});

describe('PlaylistMosaic', () => {
  it('senza copertine mostra l’iniziale del nome su un gradiente, senza immagini', async () => {
    const { mosaic, images } = await render('notturno', items(null, null));
    expect(mosaic.dataset.layout).toBe('fallback');
    expect(mosaic.textContent).toBe('N');
    expect(images()).toHaveLength(0);
    expect(mosaic.getAttribute('aria-hidden')).toBe('true');

    const empty = await render('', []);
    expect(empty.mosaic.textContent).toBe('♪');
  });

  it('con 1 o 3 copertine mostra solo la prima, intera', async () => {
    const one = await render('Viaggio', items(cover('a')));
    expect(one.mosaic.dataset.layout).toBe('single');
    expect(one.images().map((image) => image.getAttribute('src'))).toEqual([cover('a')]);

    const three = await render('Viaggio', items(cover('a'), cover('b'), cover('c')));
    expect(three.mosaic.dataset.layout).toBe('single');
    expect(three.images().map((image) => image.getAttribute('src'))).toEqual([cover('a')]);
  });

  it('con 4 o più copertine mostra le prime 4 diverse in un mosaico 2×2', async () => {
    const four = await render('Viaggio', items(cover('a'), cover('b'), cover('c'), cover('d')));
    expect(four.mosaic.dataset.layout).toBe('grid');
    expect(four.images()).toHaveLength(4);

    const five = await render(
      'Viaggio',
      items(cover('a'), cover('b'), cover('c'), cover('d'), cover('e')),
    );
    expect(five.images().map((image) => image.getAttribute('src'))).toEqual([
      cover('a'),
      cover('b'),
      cover('c'),
      cover('d'),
    ]);
  });

  it('copertine ripetute contano una volta sola', async () => {
    // 5 elementi con copertina ma solo 3 diverse: una copertina sola, mai un riquadro ripetuto.
    const { mosaic, images } = await render(
      'Viaggio',
      items(cover('a'), cover('a'), cover('b'), cover('c'), cover('b')),
    );
    expect(mosaic.dataset.layout).toBe('single');
    expect(images()).toHaveLength(1);
  });

  it('immagini decorative, caricate solo quando servono', async () => {
    const { images } = await render(
      'Viaggio',
      items(cover('a'), cover('b'), cover('c'), cover('d')),
    );
    for (const image of images()) {
      expect(image.getAttribute('alt')).toBe('');
      expect(image.getAttribute('loading')).toBe('lazy');
      expect(image.getAttribute('decoding')).toBe('async');
      // Dimensioni riservate anche prima che l'immagine arrivi.
      expect(image.getAttribute('width')).toBe('160');
      expect(image.getAttribute('height')).toBe('160');
    }
  });

  it('una copertina che non si carica lascia il colore di ripiego e il mosaico allineato', async () => {
    const { container, mosaic, images } = await render(
      'Viaggio',
      items(cover('a'), cover('b'), cover('c'), cover('d')),
    );
    await failToLoad(images()[1]);
    expect(mosaic.dataset.layout).toBe('grid');
    expect(images().map((image) => image.getAttribute('src'))).toEqual([
      cover('a'),
      cover('c'),
      cover('d'),
    ]);
    // Sempre quattro riquadri, quello fallito al suo posto (il secondo).
    expect(mosaic.children).toHaveLength(4);
    expect((mosaic.children[1] as HTMLElement).dataset.tile).toBe('failed');
    expect(container.textContent).toBe('');

    // Nessuna copertina caricata: torna l'iniziale.
    for (const image of images()) await failToLoad(image);
    expect(mosaic.dataset.layout).toBe('fallback');
    expect(mosaic.textContent).toBe('V');
  });

  it('con 1-3 copertine, se la prima non si carica prova la successiva', async () => {
    const { mosaic, images } = await render(
      'Viaggio',
      items(cover('rotta'), cover('b'), cover('c')),
    );
    await failToLoad(images()[0]);
    expect(mosaic.dataset.layout).toBe('single');
    expect(images().map((image) => image.getAttribute('src'))).toEqual([cover('b')]);
    await failToLoad(images()[0]);
    expect(images().map((image) => image.getAttribute('src'))).toEqual([cover('c')]);
    // L'iniziale torna solo quando nessuna copertina si carica.
    await failToLoad(images()[0]);
    expect(mosaic.dataset.layout).toBe('fallback');
    expect(mosaic.textContent).toBe('V');
  });

  it('se l’unica copertina non si carica torna l’iniziale', async () => {
    const { mosaic, images } = await render('ëlite', items(cover('a')));
    await failToLoad(images()[0]);
    expect(mosaic.dataset.layout).toBe('fallback');
    expect(mosaic.textContent).toBe('Ë');
    expect(images()).toHaveLength(0);
  });
});

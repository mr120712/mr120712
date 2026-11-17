// @polsia:user-owned — pagina di un genere (/generi/<slug>): il link condiviso (ShareButton di
// genre-detail) mostra il genere anche nell'anteprima social (og:title, og:description, og:url),
// con la scheda generica di Solco che un openGraph della pagina altrimenti perderebbe.
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/custom/music/genre-detail', () => ({ GenreDetail: () => null }));

import { generateMetadata } from '@/app/(custom)/generi/[slug]/page';
import { siteName } from '@/lib/brand';
import { findGenre, genreCatalog } from '@/lib/music/genre-catalog';

async function metadataFor(slug: string) {
  return generateMetadata({ params: Promise.resolve({ slug }) });
}

describe('metadati di /generi/<slug>', () => {
  it('anteprima social con il nome del genere, og:url canonico e la scheda di Solco', async () => {
    const genre = genreCatalog.find((entry) => entry.family === 'playlist');
    expect(genre).toBeDefined();
    if (!genre) return;
    const metadata = await metadataFor(genre.slug);
    const description = `${genre.description} Brani, radio e playlist ${genre.name} su Solco.`;
    expect(metadata.title).toBe(genre.name);
    expect(metadata.description).toBe(description);
    expect(metadata.alternates).toEqual({ canonical: `/generi/${genre.slug}` });
    expect(metadata.openGraph).toEqual({
      title: `${genre.name} su Solco`,
      description,
      type: 'website',
      url: `/generi/${genre.slug}`,
      images: [
        { url: '/opengraph-image', type: 'image/png', width: 1200, height: 630, alt: siteName },
      ],
    });
    expect(metadata.twitter).toEqual({
      card: 'summary_large_image',
      title: `${genre.name} su Solco`,
      description,
      images: ['/opengraph-image'],
    });
  });

  it('ogni genere del catalogo ha il proprio titolo nell’anteprima', async () => {
    for (const genre of genreCatalog.slice(0, 20)) {
      const metadata = await metadataFor(genre.slug);
      const og = metadata.openGraph as { title?: string; url?: string } | undefined;
      expect(og?.title, genre.slug).toBe(`${findGenre(genre.slug)?.name} su Solco`);
      expect(og?.url, genre.slug).toBe(`/generi/${genre.slug}`);
    }
  });

  it('una playlist divertente si presenta come tale, con la stessa scheda di Solco', async () => {
    const playlist = findGenre('piede-comodino');
    expect(playlist?.family).toBe('divertenti');
    const metadata = await metadataFor('piede-comodino');
    expect(metadata.title).toBe('Piede comodino');
    expect(metadata.description).toBe(
      `${playlist?.description} La playlist divertente di Solco, pronta da ascoltare: brani, radio e altro.`,
    );
    const og = metadata.openGraph as { title?: string; url?: string; images?: unknown[] };
    expect(og.title).toBe('Piede comodino su Solco');
    expect(og.url).toBe('/generi/piede-comodino');
    expect(og.images).toEqual([
      { url: '/opengraph-image', type: 'image/png', width: 1200, height: 630, alt: siteName },
    ]);
  });

  it('un genere sconosciuto non ha metadati propri', async () => {
    expect(await metadataFor('non-esiste')).toEqual({});
  });
});

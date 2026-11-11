// @polsia:user-owned
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { decodeXmlText, parsePodcastFeed } from '@/lib/music/podcasts.server';

// Vicino al tetto di 6 MB del feed: il parser originale, quadratico, impiegava minuti.
const SIZE = 5 * 1024 * 1024;

function pad(fragment: string, size = SIZE) {
  return fragment.repeat(Math.ceil(size / fragment.length));
}

function timed<T>(run: () => T) {
  const started = performance.now();
  const result = run();
  return { result, ms: performance.now() - started };
}

const validItem = `<item>
  <title>Episodio valido</title>
  <guid>ok-1</guid>
  <enclosure url="https://cdn.example.com/ok.mp3" type="audio/mpeg"/>
</item>`;

describe('podcast: feed ostile', () => {
  it('migliaia di <item> non chiusi vengono elaborati in tempo lineare', () => {
    const { result, ms } = timed(() => parsePodcastFeed(`<rss><channel>${pad('<item>')}`));
    expect(result.episodes).toEqual([]);
    expect(ms).toBeLessThan(500);
  });

  it('tag, CDATA ed entità non chiusi dentro un item non bloccano il parsing', () => {
    const hostileItem = `<item>
      <enclosure url="https://cdn.example.com/a.mp3" type="audio/mpeg"/>
      <title><![CDATA[Titolo]]></title>
      <description>${pad('&lt;<![CDATA[', SIZE / 3)}</description>
      ${pad('<title <enclosure <itunes:image <guid ', SIZE / 3)}
    </item>`;
    // Resta sotto il tetto di 6 MB, così l'item valido finale viene raggiunto.
    const feed = `<rss><channel>${pad('<itunes:image ', SIZE / 3)}${hostileItem}${validItem}</channel></rss>`;
    const { result, ms } = timed(() => parsePodcastFeed(feed));
    expect(ms).toBeLessThan(500);
    expect(result.episodes.map((episode) => episode.title)).toEqual(['Titolo', 'Episodio valido']);
    expect(result.episodes[0]?.description?.length).toBeLessThanOrEqual(600);
  });

  it('molti item scartati restano entro il tempo e il tetto di item esaminati', () => {
    const skipped = '<item><title>x</title><enclosure url="http://a/b" type="audio/mpeg"/></item>';
    const feed = `<rss><channel>${pad(skipped)}${validItem}</channel></rss>`;
    const { result, ms } = timed(() => parsePodcastFeed(feed));
    expect(ms).toBeLessThan(500);
    // L'item valido arriva dopo il tetto di item esaminati: non viene raggiunto.
    expect(result.episodes).toEqual([]);
  });

  it('decodeXmlText resta lineare con CDATA ed entità non chiusi', () => {
    const { result, ms } = timed(() => decodeXmlText(pad('<![CDATA[&#x41')));
    expect(ms).toBeLessThan(500);
    expect(result.startsWith('<![CDATA[&#x41')).toBe(true);
  });

  it('mantiene la semantica su CDATA, tag e item annidati', () => {
    expect(decodeXmlText('<![CDATA[a]]> e <![CDATA[b]]> <![CDATA[c')).toBe('a e b <![CDATA[c');
    const parsed = parsePodcastFeed(`<rss><channel>
      <itunes:image href="https://cdn.example.com/show.jpg"/>
      <item><title>Uno <b>grassetto</b> &lt;i&gt;</title>
        <enclosure url="https://cdn.example.com/1.mp3"/>
      <item><title>Annidato</title></item>
      <ITEM><TITLE>Maiuscolo</TITLE><ENCLOSURE URL="https://cdn.example.com/2.mp3"/></ITEM>
    </channel></rss>`);
    expect(parsed.artworkUrl).toBe('https://cdn.example.com/show.jpg');
    expect(parsed.episodes.map((episode) => episode.title)).toEqual(['Uno grassetto', 'Maiuscolo']);
  });
});

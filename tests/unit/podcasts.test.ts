// @polsia:user-owned
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  assertPublicHttpsUrl,
  decodeXmlText,
  episodeKeyFor,
  normalizeItunesPodcast,
  parseDuration,
  parsePodcastFeed,
} from '@/lib/music/podcasts.server';

const feed = `<?xml version="1.0"?>
<rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
<channel>
  <title>Show di prova</title>
  <itunes:image href="https://cdn.example.com/show.jpg"/>
  <item>
    <title><![CDATA[Episodio 2: suoni & storie]]></title>
    <guid isPermaLink="false">ep-2</guid>
    <pubDate>Tue, 10 Nov 2026 08:00:00 GMT</pubDate>
    <itunes:duration>01:02:03</itunes:duration>
    <description><![CDATA[<p>Una <b>puntata</b> &amp; molto altro</p>]]></description>
    <enclosure url="https://cdn.example.com/ep2.mp3" length="1" type="audio/mpeg"/>
  </item>
  <item>
    <title>Episodio video</title>
    <enclosure url="https://cdn.example.com/ep.mp4" type="video/mp4"/>
  </item>
  <item>
    <title>Episodio non sicuro</title>
    <enclosure url="http://cdn.example.com/ep.mp3" type="audio/mpeg"/>
  </item>
  <item>
    <title>Episodio 1</title>
    <itunes:duration>754</itunes:duration>
    <itunes:image href="https://cdn.example.com/ep1.jpg"/>
    <enclosure url='https://cdn.example.com/ep1.mp3' type='audio/mpeg'/>
  </item>
</channel>
</rss>`;

describe('podcast', () => {
  it('estrae solo episodi audio HTTPS con metadati puliti', () => {
    const parsed = parsePodcastFeed(feed);
    expect(parsed.artworkUrl).toBe('https://cdn.example.com/show.jpg');
    expect(parsed.episodes.map((episode) => episode.title)).toEqual([
      'Episodio 2: suoni & storie',
      'Episodio 1',
    ]);
    const [second, first] = parsed.episodes;
    expect(second?.key).toBe(episodeKeyFor('ep-2'));
    expect(second?.durationSeconds).toBe(3723);
    expect(second?.publishedAt).toBe('2026-11-10T08:00:00.000Z');
    expect(second?.description).toBe('Una puntata & molto altro');
    expect(first?.key).toBe(episodeKeyFor('https://cdn.example.com/ep1.mp3'));
    expect(first?.durationSeconds).toBe(754);
    expect(first?.artworkUrl).toBe('https://cdn.example.com/ep1.jpg');
    expect(first?.key).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('decodifica entità e durate', () => {
    expect(decodeXmlText('a &amp; b &#233; &#x41; <![CDATA[c]]>')).toBe('a & b é A c');
    expect(parseDuration('45:10')).toBe(2710);
    expect(parseDuration('n/d')).toBeNull();
  });

  it('normalizza i risultati della directory', () => {
    expect(
      normalizeItunesPodcast({
        collectionId: 123,
        collectionName: 'Show',
        artistName: 'Autore',
        artworkUrl600: 'https://is1.example.com/600.jpg',
        primaryGenreName: 'Musica',
      }),
    ).toEqual({
      id: '123',
      title: 'Show',
      author: 'Autore',
      artworkUrl: 'https://is1.example.com/600.jpg',
      genre: 'Musica',
    });
    expect(normalizeItunesPodcast({ collectionId: 'abc', collectionName: 'X' })).toBeNull();
  });

  it('blocca feed non HTTPS o verso reti private (SSRF)', async () => {
    const publicDns = async () => ['93.184.216.34'];
    await expect(
      assertPublicHttpsUrl('https://feeds.example.com/rss', publicDns),
    ).resolves.toBeInstanceOf(URL);
    await expect(assertPublicHttpsUrl('http://feeds.example.com/rss', publicDns)).rejects.toThrow();
    await expect(assertPublicHttpsUrl('https://127.0.0.1/rss', publicDns)).rejects.toThrow();
    await expect(assertPublicHttpsUrl('https://[::1]/rss', publicDns)).rejects.toThrow();
    await expect(assertPublicHttpsUrl('https://localhost/rss', publicDns)).rejects.toThrow();
    await expect(
      assertPublicHttpsUrl('https://internal.example.com/rss', async () => ['10.0.0.5']),
    ).rejects.toThrow();
    await expect(
      assertPublicHttpsUrl('https://meta.example.com/rss', async () => ['169.254.169.254']),
    ).rejects.toThrow();
  });
});

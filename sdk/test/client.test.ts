import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SolcoClient } from '../src/client.js';
import type { FetchLike } from '../src/http.js';
import type { OfflineDownloadMeta } from '../src/types.js';

function recorder(response: (url: string) => Response): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const fetch: FetchLike = async (url) => {
    urls.push(url);
    return response(url);
  };
  return { fetch, urls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('music.searchAll aggiunge youtubeConsent solo con youtube:true', async () => {
  const rec = recorder(() =>
    json({ query: 'x', youtubeRequested: true, results: [], sources: {} }),
  );
  const solco = new SolcoClient({ baseUrl: 'https://example.test', fetch: rec.fetch });
  await solco.music.searchAll({ q: 'nina', youtube: true });
  await solco.music.searchAll({ q: 'nina' });
  assert.equal(
    rec.urls[0],
    'https://example.test/api/music/search-all?q=nina&youtubeConsent=accepted',
  );
  assert.equal(rec.urls[1], 'https://example.test/api/music/search-all?q=nina');
});

test('music.search usa audius di default e non manda consenso', async () => {
  const rec = recorder(() => json({ source: 'audius' }));
  const solco = new SolcoClient({ baseUrl: 'https://example.test', fetch: rec.fetch });
  await solco.music.search({ q: 'test' });
  assert.equal(rec.urls[0], 'https://example.test/api/music/search?source=audius&q=test');
});

test('music.youtubeCharts passa la regione', async () => {
  const rec = recorder(() => json({ outcome: 'results', regionCode: 'US', videos: [] }));
  const solco = new SolcoClient({ baseUrl: 'https://example.test', fetch: rec.fetch });
  await solco.music.youtubeCharts({ region: 'US' });
  assert.equal(rec.urls[0], 'https://example.test/api/music/youtube/charts?region=US');
});

test('radio.list filtra i parametri vuoti', async () => {
  const rec = recorder(() => json({ outcome: 'results', stations: [] }));
  const solco = new SolcoClient({ baseUrl: 'https://example.test', fetch: rec.fetch });
  await solco.radio.list({ country: 'IT' });
  assert.equal(rec.urls[0], 'https://example.test/api/music/radio?country=IT');
});

test('auth.getSession restituisce null quando non autenticato', async () => {
  const rec = recorder(() => json(null));
  const solco = new SolcoClient({ baseUrl: 'https://example.test', fetch: rec.fetch });
  assert.equal(await solco.auth.getSession(), null);
});

test('offline.downloadAudiusTrack decodifica i metadati base64', async () => {
  const meta: OfflineDownloadMeta = {
    source: 'audius-download',
    downloadKey: 'trk1',
    title: 'Canzone à è ì',
    artist: 'Artista',
    album: null,
    durationSeconds: 180,
    mimeType: 'audio/mpeg',
    attribution: {
      sourceName: 'Audius',
      sourceUrl: 'https://audius.co/x',
      licenseName: 'Open Music License',
      licenseUrl: 'https://audius.co/legal',
      creditLine: 'Artista — Open Music License',
    },
  };
  const header = Buffer.from(JSON.stringify(meta)).toString('base64');
  const rec = recorder(
    () =>
      new Response(new Uint8Array([9, 8, 7]), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg', 'x-solco-download': header },
      }),
  );
  const solco = new SolcoClient({ baseUrl: 'https://example.test', fetch: rec.fetch });
  const result = await solco.offline.downloadAudiusTrack('trk1');
  assert.equal(rec.urls[0], 'https://example.test/api/music/audius/tracks/trk1/download');
  assert.deepEqual([...result.bytes], [9, 8, 7]);
  assert.equal(result.meta.title, 'Canzone à è ì');
  assert.equal(result.meta.attribution.licenseName, 'Open Music License');
});

test('plays.record manda qualifiedId in POST', async () => {
  const rec = recorder(() => json({ allowed: true, used: 1, limit: 40 }));
  const solco = new SolcoClient({ baseUrl: 'https://example.test', fetch: rec.fetch });
  const res = await solco.plays.record('audius:xyz');
  assert.equal(rec.urls[0], 'https://example.test/api/music/plays');
  assert.equal(res.allowed, true);
  assert.equal(res.limit, 40);
});

test('baseUrl di default è il sito di produzione', () => {
  const solco = new SolcoClient();
  assert.equal(solco.baseUrl, 'https://solcomusic.vercel.app');
});

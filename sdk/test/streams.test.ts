import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Streams } from '../src/streams.js';

const s = new Streams('https://example.test');

test('URL di stream per fonte', () => {
  assert.equal(s.audius('abc'), 'https://example.test/api/music/audius/tracks/abc/stream');
  assert.equal(s.jamendo('123'), 'https://example.test/api/music/jamendo/123/stream');
  assert.equal(s.radio('st1'), 'https://example.test/api/music/radio/st1/stream');
  assert.equal(
    s.podcastEpisode('p1', 'e1'),
    'https://example.test/api/music/podcasts/p1/episodes/e1/stream',
  );
  assert.equal(
    s.albumTrack('al1', 'tr1'),
    'https://example.test/api/music/albums/al1/tracks/tr1/stream',
  );
});

test('gli id vengono codificati per l’URL', () => {
  assert.equal(
    s.podcastEpisode('p/1', 'e 1'),
    'https://example.test/api/music/podcasts/p%2F1/episodes/e%201/stream',
  );
});

test('YouTube: watch ed embed ufficiali', () => {
  assert.equal(s.youtubeWatch('dQw4w9WgXcQ'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(s.youtubeEmbed('dQw4w9WgXcQ'), 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
});

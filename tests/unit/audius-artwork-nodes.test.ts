// @polsia:user-owned
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { normalizeAudiusTracks } from '@/lib/music/audius';

const CID = 'baeaaaiqsec3v4qj7c6afbm4jcuij6qqq4ycn5plde7u6lhldnierwopply35m';

function track(artworkBase: string) {
  return {
    data: [
      {
        id: 'J7Xb000',
        title: 'Murder She Wrote',
        permalink: '/brookeevers/murder-she-wrote',
        duration: 180,
        is_available: true,
        is_streamable: true,
        is_stream_gated: false,
        access: { stream: true, download: true },
        access_authorities: [],
        license: null,
        artwork: {
          '150x150': `${artworkBase}/content/${CID}/150x150.jpg`,
          '480x480': `${artworkBase}/content/${CID}/480x480.jpg`,
          '1000x1000': `${artworkBase}/content/${CID}/1000x1000.jpg`,
        },
        user: { id: 'u1', handle: 'brookeevers', name: 'Brooke Evers' },
      },
    ],
  };
}

describe('copertine Audius servite dai nodi della rete', () => {
  it.each([
    'https://audius-01.staked.cloud',
    'https://v.monophonic.digital',
    'https://val011.open-audio-validator.com',
    'https://cn0.mainnet.audiusindex.org',
    'https://creatornode.audius.co',
  ])('accetta %s', (base) => {
    const [result] = normalizeAudiusTracks(track(base), true);
    expect(result?.artworkUrl).toBe(`${base}/content/${CID}/480x480.jpg`);
  });

  it.each([
    'http://audius-01.staked.cloud',
    'https://user:pass@audius-01.staked.cloud',
    'https://audius-01.staked.cloud:8443',
  ])('rifiuta %s', (base) => {
    expect(normalizeAudiusTracks(track(base), true)).toEqual([]);
  });

  it('rifiuta un percorso che non è quello delle copertine Audius', () => {
    const payload = track('https://evil.example');
    const [first] = payload.data;
    if (!first) throw new Error('missing track');
    first.artwork = {
      '150x150': 'https://evil.example/tracker.gif',
      '480x480': 'https://evil.example/tracker.gif',
      '1000x1000': 'https://evil.example/tracker.gif',
    };
    expect(normalizeAudiusTracks(payload, true)).toEqual([]);
  });
});

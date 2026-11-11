// @polsia:user-owned
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { normalizeAudiusTracks } from '@/lib/music/audius';

const publicTrack = {
  id: 'track-71',
  title: 'Brano pubblico',
  permalink: 'https://audius.co/sample-artist/brano-pubblico',
  artwork: { '480x480': 'https://audius.co/images/cover.jpg' },
  duration: 183,
  is_available: true,
  is_streamable: true,
  is_stream_gated: false,
  access_authorities: [],
  access: { stream: true },
  user: {
    id: 'artist-71',
    name: 'Artista di esempio',
    handle: 'sample-artist',
  },
};

describe('streaming pubblico Audius', () => {
  it('consente un brano quando Audius conferma disponibilità e accesso pubblico allo stream', () => {
    const [track] = normalizeAudiusTracks({ data: publicTrack }, true);

    expect(track).toMatchObject({
      id: 'track-71',
      title: 'Brano pubblico',
      playbackEligible: true,
      playbackReason: 'ready',
    });
  });

  it('nega un brano quando Audius non autorizza l’accesso allo stream', () => {
    const [track] = normalizeAudiusTracks(
      { data: { ...publicTrack, access: { stream: false } } },
      true,
    );

    expect(track).toMatchObject({ playbackEligible: false, playbackReason: 'access_denied' });
  });

  it('non considera pubblico un brano con accesso o stato non confermato', () => {
    const [track] = normalizeAudiusTracks(
      { data: { ...publicTrack, access: null, is_stream_gated: undefined } },
      true,
    );

    expect(track).toMatchObject({ playbackEligible: false, playbackReason: 'state_unknown' });
  });
});

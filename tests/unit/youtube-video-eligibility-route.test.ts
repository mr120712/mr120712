// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ readKey: vi.fn(), getDetails: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/music/music-api.server', () => ({ readYouTubeApiKey: mocks.readKey }));
vi.mock('@/lib/music/youtube-search.server', () => ({ getYouTubeVideoDetails: mocks.getDetails }));

import { GET } from '@/app/api/music/youtube/videos/[videoId]/route';

const video = {
  provider: 'youtube', videoId: 'dQw4w9WgXcQ', title: 'Video ufficiale',
  channelTitle: 'Canale ufficiale', channelId: 'UCsample123', description: null,
  publishedAt: null, thumbnailUrl: null,
};

async function getEligibility() {
  return GET(new Request('https://solco.test/api/music/youtube/videos/dQw4w9WgXcQ'), {
    params: Promise.resolve({ videoId: video.videoId }),
  });
}

beforeEach(() => {
  mocks.readKey.mockReset().mockReturnValue('server-only-key');
  mocks.getDetails.mockReset();
});

describe('verifica prima dell’embed YouTube ufficiale', () => {
  it('indica il nome esatto del segreto quando manca la chiave senza esporre valori', async () => {
    mocks.readKey.mockReturnValue('');
    mocks.getDetails.mockResolvedValue({ outcome: 'not_configured' });
    const response = await getEligibility();
    const body = await response.json();
    expect(body.eligibility).toBe('unavailable');
    expect(body.message).toContain('YOUTUBE_DATA_API_KEY');
    expect(JSON.stringify(body)).not.toContain('server-only-key');
  });

  it('ferma l’embed quando la quota è esaurita o lo stato di audience non è disponibile', async () => {
    mocks.getDetails.mockResolvedValueOnce({ outcome: 'quota_exceeded' });
    const quota = await getEligibility();
    expect((await quota.json()).message).toContain('quota');

    mocks.getDetails.mockResolvedValueOnce({ outcome: 'found', details: { video, madeForKids: null } });
    const unknown = await getEligibility();
    expect((await unknown.json()).eligibility).toBe('unknown');
  });

  it('restituisce il permesso soltanto per dettagli correnti e audience verificata', async () => {
    mocks.getDetails.mockResolvedValue({ outcome: 'found', details: { video, madeForKids: false } });
    const response = await getEligibility();
    expect(await response.json()).toMatchObject({ videoId: video.videoId, eligibility: 'playable', video });
    expect(mocks.getDetails).toHaveBeenCalledWith(video.videoId, 'server-only-key');
  });

  it('non carica un video indicato da YouTube come Made for Kids', async () => {
    mocks.getDetails.mockResolvedValue({ outcome: 'found', details: { video, madeForKids: true } });
    const response = await getEligibility();
    expect((await response.json()).eligibility).toBe('made_for_kids');
  });
});

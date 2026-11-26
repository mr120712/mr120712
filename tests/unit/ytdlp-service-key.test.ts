// @polsia:user-owned
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { ytdlpServiceKey } from '@/lib/business/bot-video.server';

describe('ytdlpServiceKey (rotazione)', () => {
  it('preferisce YTDLP_SERVICE_KEY2 quando è impostata', () => {
    expect(ytdlpServiceKey({ YTDLP_SERVICE_KEY: 'a', YTDLP_SERVICE_KEY2: 'b' })).toBe('b');
  });
  it('ripiega su YTDLP_SERVICE_KEY se la seconda manca o è vuota', () => {
    expect(ytdlpServiceKey({ YTDLP_SERVICE_KEY: 'a' })).toBe('a');
    expect(ytdlpServiceKey({ YTDLP_SERVICE_KEY: 'a', YTDLP_SERVICE_KEY2: '  ' })).toBe('a');
  });
  it('nessuna chiave → undefined', () => {
    expect(ytdlpServiceKey({})).toBeUndefined();
  });
});

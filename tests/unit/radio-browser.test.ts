// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  clearRadioCache,
  listStations,
  normalizeStation,
  radioSearchPath,
  resolveStationStream,
} from '@/lib/music/radio-browser.server';

const station = {
  stationuuid: '9617a958-0601-11e8-ae97-52543be04c81',
  name: '  Radio Prova  ',
  url: 'http://stream.example.com/live',
  url_resolved: 'https://stream.example.com/live.mp3',
  homepage: 'https://radio.example.com',
  favicon: 'https://radio.example.com/logo.png',
  country: 'Italy',
  countrycode: 'it',
  tags: 'Pop, Dance,,News',
  codec: 'MP3',
  bitrate: 128,
  votes: 42,
  lastcheckok: 1,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => clearRadioCache());

describe('Radio Browser', () => {
  it('normalizza una stazione con stream HTTPS', () => {
    expect(normalizeStation(station)).toEqual({
      id: station.stationuuid,
      name: 'Radio Prova',
      artworkUrl: 'https://radio.example.com/logo.png',
      country: 'Italy',
      countryCode: 'IT',
      tags: ['pop', 'dance', 'news'],
      codec: 'MP3',
      bitrate: 128,
      homepage: 'https://radio.example.com/',
      votes: 42,
    });
  });

  it('scarta stazioni senza stream HTTPS, guaste o con ID non valido', () => {
    expect(normalizeStation({ ...station, url: 'http://a', url_resolved: 'http://b' })).toBeNull();
    expect(normalizeStation({ ...station, lastcheckok: 0 })).toBeNull();
    expect(normalizeStation({ ...station, hls: 1 })).toBeNull();
    expect(
      normalizeStation({ ...station, url_resolved: 'https://cdn.example.com/live/master.m3u8' }),
    ).toBeNull();
    expect(normalizeStation({ ...station, stationuuid: '../../etc' })).toBeNull();
    expect(
      normalizeStation({ ...station, favicon: 'http://insecure/logo.png' })?.artworkUrl,
    ).toBeNull();
  });

  it('costruisce la ricerca con filtri e ordinamento per voti', () => {
    const path = radioSearchPath({ q: 'jazz fm', tag: 'Jazz', country: 'it', limit: 10 });
    const params = new URL(path, 'https://x').searchParams;
    expect(params.get('name')).toBe('jazz fm');
    expect(params.get('tag')).toBe('jazz');
    expect(params.get('countrycode')).toBe('IT');
    expect(params.get('is_https')).toBe('true');
    expect(params.get('order')).toBe('votes');
  });

  it('elenca stazioni deduplicate e passa al mirror successivo se il primo fallisce', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(jsonResponse([station, station, { name: 'senza id' }]));
    const result = await listStations({ limit: 5 }, fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.outcome).toBe('results');
    expect(result.stations).toHaveLength(1);
  });

  it('segnala indisponibilità quando tutti i mirror falliscono', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({}, 503));
    const result = await listStations({ limit: 5 }, fetcher as unknown as typeof fetch);
    expect(result).toEqual({ outcome: 'unavailable', stations: [] });
  });

  it('risolve solo stream HTTPS per UUID', async () => {
    const ok = vi.fn().mockResolvedValue(jsonResponse([station]));
    await expect(
      resolveStationStream(station.stationuuid, ok as unknown as typeof fetch),
    ).resolves.toBe('https://stream.example.com/live.mp3');
    clearRadioCache();
    const insecure = vi
      .fn()
      .mockResolvedValue(jsonResponse([{ ...station, url_resolved: 'http://x', url: 'http://y' }]));
    await expect(
      resolveStationStream(station.stationuuid, insecure as unknown as typeof fetch),
    ).resolves.toBeNull();
    await expect(
      resolveStationStream('bad id!', ok as unknown as typeof fetch),
    ).resolves.toBeNull();
  });
});

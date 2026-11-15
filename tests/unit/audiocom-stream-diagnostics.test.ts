// @polsia:user-owned — diagnostica temporanea degli stream di audio.com scartati: solo motivo, host
// ed estensione (mai l'URL completo né i parametri), e solo per i brani con licenza riproducibile.
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/business/rate-limit.server', () => ({ consumeRateLimit: vi.fn() }));

import { toAudioComTrack } from '@/lib/music/audiocom.server';
import {
  audioComStreamDiagnostics,
  clearAudioComStreamDiagnostics,
  describeRejectedAudioComStream,
  noteRejectedAudioComStream,
} from '@/lib/music/audiocom-stream-diagnostics';

beforeEach(() => clearAudioComStreamDiagnostics());

describe('describeRejectedAudioComStream', () => {
  it('vuoto, relativo, non-url', () => {
    expect(describeRejectedAudioComStream(undefined)).toBe('vuoto');
    expect(describeRejectedAudioComStream('  ')).toBe('vuoto');
    expect(describeRejectedAudioComStream('/s3w/a.mp3')).toBe('relativo');
    expect(describeRejectedAudioComStream('abc')).toBe('non-url');
  });

  it('host, estensione e dettagli senza percorso né parametri', () => {
    expect(
      describeRejectedAudioComStream('https://cdn.example.net/a/b/123.mp3?Signature=segreto'),
    ).toBe('cdn.example.net mp3 query[Signature]');
    expect(describeRejectedAudioComStream('http://audio.com:8080/x.m3u8')).toBe(
      'audio.com m3u8 http porta',
    );
  });

  it('link firmato: nomi dei parametri, durata e tempo rimasto, mai i valori', () => {
    const now = Date.UTC(2026, 10, 15, 16, 0, 0);
    const signed =
      'https://s3.example.com/b/a.mp3?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIASEGRETO' +
      '&X-Amz-Date=20261115T155000Z&X-Amz-Expires=3600&X-Amz-Signature=firmasegreta';
    const text = describeRejectedAudioComStream(signed, now);
    expect(text).toBe(
      's3.example.com mp3 query[X-Amz-Algorithm|X-Amz-Credential|X-Amz-Date|X-Amz-Expires|X-Amz-Signature] durata=3600s resta=3000s',
    );
    expect(text).not.toContain('SEGRETO');
    expect(text).not.toContain('firmasegreta');
    const expires = now / 1000 + 36_000;
    expect(describeRejectedAudioComStream(`https://h.example/a.mp3?Expires=${expires}`, now)).toBe(
      'h.example mp3 query[Expires] resta=36000s',
    );
  });

  it('per host ed estensione resta l’ultima voce', () => {
    noteRejectedAudioComStream('https://h.example/a.mp3?v=1');
    noteRejectedAudioComStream('https://h.example/b.mp3?w=2');
    expect(audioComStreamDiagnostics()).toBe('h.example mp3 query[w]');
  });

  it('al più 8 voci diverse', () => {
    for (let index = 0; index < 12; index += 1) {
      noteRejectedAudioComStream(`https://h${index}.example/a.mp3`);
    }
    expect(audioComStreamDiagnostics().split(', ')).toHaveLength(8);
  });
});

describe('toAudioComTrack', () => {
  const hit = (license: string, url: string) => ({
    type: 'audio',
    model: {
      id: '1871803593412229',
      title: 'Ambient',
      slug: 'ambient',
      username: 'autore',
      category: 'music',
      license,
      play: { url, duration: 133_000 },
    },
  });

  it('annota solo i brani con licenza riproducibile e stream scartato', () => {
    expect(toAudioComTrack(hit('arr', 'https://altro.example/a.mp3'))?.streamUrl).toBeNull();
    expect(audioComStreamDiagnostics()).toBe('');
    expect(toAudioComTrack(hit('cc-0', 'https://altro.example/a.mp3?t=1'))?.streamUrl).toBeNull();
    expect(audioComStreamDiagnostics()).toBe('altro.example mp3 query[t]');
    expect(toAudioComTrack(hit('cc-0', 'https://s3.audio.com/a.mp3'))?.streamUrl).toBe(
      'https://s3.audio.com/a.mp3',
    );
    expect(audioComStreamDiagnostics()).toBe('altro.example mp3 query[t]');
  });
});

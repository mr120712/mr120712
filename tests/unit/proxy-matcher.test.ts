// @vitest-environment node
// @polsia:user-owned — il matcher di src/proxy.ts provato con la funzione di Next che decide se il
// proxy gira: le richieste con gli header di prefetch (che sceglie il client) passano dal proxy, e
// quindi dal gate dell'Under Attack Mode; le API e i file di _next restano fuori.
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { describe, expect, it } from 'vitest';
import { config } from '@/proxy';

const ORIGIN = 'https://www.solcomusic.online';

function matches(path: string, headers: Record<string, string> = {}): boolean {
  return unstable_doesMiddlewareMatch({ config, url: `${ORIGIN}${path}`, headers });
}

describe('matcher del proxy', () => {
  it('nessuna clausola `missing`: gli header della richiesta non possono saltare il proxy', () => {
    for (const matcher of config.matcher) {
      expect(matcher).not.toHaveProperty('missing');
      expect(matcher).not.toHaveProperty('has');
    }
  });

  it.each([
    ['Purpose: prefetch', { purpose: 'prefetch' }],
    ['Next-Router-Prefetch: 1', { 'next-router-prefetch': '1' }],
    ['Next-Router-Prefetch: x', { 'next-router-prefetch': 'x' }],
    ['RSC + prefetch', { rsc: '1', 'next-router-prefetch': '1', purpose: 'prefetch' }],
    ['Sec-Purpose: prefetch', { 'sec-purpose': 'prefetch' }],
  ])('le pagine con %s passano dal proxy (e dal gate)', (_label, headers) => {
    for (const path of ['/', '/music', '/search?q=x', '/albums/abc', '/playlist/x']) {
      expect(matches(path, headers), path).toBe(true);
    }
  });

  it('le pagine senza header particolari passano dal proxy', () => {
    for (const path of ['/', '/music', '/albums/x.png', '/stato', '/sw.js', '/health']) {
      expect(matches(path), path).toBe(true);
    }
  });

  it('le API, gli asset di _next e /favicon.ico restano fuori dal proxy', () => {
    for (const path of [
      '/api',
      '/api/',
      '/api/uam/verify',
      '/api/telegram/webhook',
      '/_next/static/chunks/app.js',
      '/_next/image',
      '/_next/image?url=%2Fx.png&w=64&q=75',
      '/favicon.ico',
    ]) {
      expect(matches(path), path).toBe(false);
      expect(matches(path, { purpose: 'prefetch' }), path).toBe(false);
    }
  });

  it('le esclusioni si fermano al confine del segmento: niente prefissi che saltano il proxy', () => {
    // Prima /apiary, /api-docs e /favicon.icox saltavano proxy, gate e CSP (e Next li rispondeva
    // con not-found renderizzato).
    for (const path of [
      '/apiary',
      '/api-docs',
      '/apix/y',
      '/favicon.icox',
      '/faviconXico',
      '/favicon.ico/x',
      '/_next/imagex',
      '/_next/static',
    ]) {
      expect(matches(path), path).toBe(true);
    }
  });
});

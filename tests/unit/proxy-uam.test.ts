// @polsia:user-owned — il proxy con l'Under Attack Mode di Solco collegato: spento senza
// configurazione, attivo con UAM_MODE + UAM_SECRET, mai sulle API, e la CSP resta sempre.
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { proxy } from '@/proxy';

const SECRET = 'proxy-test-secret-0123456789-abcdefgh';
const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';

function request(path: string, method = 'GET') {
  return new NextRequest(`https://www.solcomusic.online${path}`, {
    method,
    headers: { 'x-real-ip': '203.0.113.42', 'user-agent': UA },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('proxy + Under Attack Mode', () => {
  it('senza configurazione la pagina passa, con la CSP stretta', async () => {
    vi.stubEnv('UAM_MODE', '');
    const response = await proxy(request('/'));
    expect(response.headers.get('x-solco-gate')).toBeNull();
    expect(response.headers.get('content-security-policy')).toContain("'strict-dynamic'");
    expect(response.headers.get('x-solco-edge')).toBe('1');
  });

  it('modalità attacco: schermata di verifica (503) prima delle pagine', async () => {
    vi.stubEnv('UAM_MODE', 'attack');
    vi.stubEnv('UAM_SECRET', SECRET);
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://www.solcomusic.online');
    const response = await proxy(request('/'));
    expect(response.status).toBe(503);
    expect(response.headers.get('x-solco-gate')).toBe('challenge');
    expect(response.headers.get('retry-after')).toBe('5');
    expect(response.headers.get('content-type')).toContain('text/html');
  });

  it('le API, le immagini di anteprima e /health non vengono mai fermate', async () => {
    vi.stubEnv('UAM_MODE', 'attack');
    vi.stubEnv('UAM_SECRET', SECRET);
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://www.solcomusic.online');
    for (const path of ['/api/telegram/webhook', '/search/anteprima.png', '/health']) {
      const response = await proxy(request(path, path.startsWith('/api') ? 'POST' : 'GET'));
      expect(response.headers.get('x-solco-gate'), path).toBeNull();
    }
  });

  it('segreto troppo corto: spenta (mai un blocco per una configurazione sbagliata)', async () => {
    vi.stubEnv('UAM_MODE', 'attack');
    vi.stubEnv('UAM_SECRET', 'corto');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://www.solcomusic.online');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const response = await proxy(request('/'));
    expect(response.headers.get('x-solco-gate')).toBeNull();
  });
});

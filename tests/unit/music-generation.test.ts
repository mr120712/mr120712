// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/lib/require-auth';

const mocks = vi.hoisted(() => ({
  requireSolcoPro: vi.fn(),
  sameOrigin: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/business/solco-pro-entitlement', () => ({
  requireSolcoPro: mocks.requireSolcoPro,
}));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));

import { GET, POST } from '@/app/api/music-generation/route';

const proUser = { id: 'pro-account', email: 'pro@solco.test' } as SessionUser;

function request(method: 'GET' | 'POST', body?: unknown, origin = 'https://solco.test') {
  return new Request('https://solco.test/api/music-generation', {
    method,
    headers: method === 'POST' ? { origin, 'content-type': 'application/json' } : undefined,
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.sameOrigin.mockReturnValue(true);
  mocks.requireSolcoPro.mockResolvedValue({ allowed: true, user: proUser });
});

describe('API di creazione musicale', () => {
  it('nega a un visitatore non autenticato prima di esporre la libreria', async () => {
    const unauthorized = Response.json({ error: 'Unauthorized' }, { status: 401 });
    mocks.requireSolcoPro.mockResolvedValueOnce({ allowed: false, response: unauthorized });

    const response = await GET(request('GET'));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });

  it('nega a un account non Pro senza avviare o archiviare una generazione', async () => {
    const forbidden = Response.json({ error: 'pro_required' }, { status: 403 });
    mocks.requireSolcoPro.mockResolvedValueOnce({ allowed: false, response: forbidden });

    const response = await POST(request('POST', { prompt: 'Un brano strumentale lento e delicato.' }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'pro_required' });
    expect(mocks.requireSolcoPro).toHaveBeenCalledTimes(1);
  });

  it('rifiuta richieste cross-origin prima di controlli Pro o operazioni applicative', async () => {
    mocks.sameOrigin.mockReturnValueOnce(false);

    const response = await POST(request('POST', { prompt: 'Un brano strumentale lento e delicato.' }, 'https://altro.test'));

    expect(response.status).toBe(403);
    expect(mocks.requireSolcoPro).not.toHaveBeenCalled();
  });

  it('non dichiara successo né crea un risultato quando manca il provider musicale', async () => {
    const response = await POST(request('POST', {
      prompt: 'Un brano strumentale lento, con piano e percussioni leggere.',
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'music_provider_not_configured' });
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('non espone una libreria vuota come se la generazione fosse pronta', async () => {
    const response = await GET(request('GET'));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'music_provider_not_configured' });
  });

  it('controlla lo stato Pro anche quando non è verificabile', async () => {
    const unavailable = Response.json({ error: 'pro_status_unavailable' }, { status: 503 });
    mocks.requireSolcoPro.mockResolvedValueOnce({ allowed: false, response: unavailable });

    const response = await GET(request('GET'));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'pro_status_unavailable' });
  });
});

// @polsia:user-owned — GPT-6 di Skynet (MagnetAPI): ciò che parte verso il servizio terzo è
// anonimizzato (email abbreviate, IP mascherati, segreti cancellati), la chiave va solo a
// api.magnetapi.org senza redirect, e gli errori diventano null. Rete finta.
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { gpt6Chat, maskEmails, redactForThirdParty } from '@/lib/skynet/gpt6.server';

const KEY = 'mk-skynet-test-key-0001';
const SECRET = 'super-secret-value-123456';

function fakeFetch(status: number, body: unknown) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status }),
  );
}

const base = {
  model: 'gpt-6.2-sol' as const,
  system: 'Sei Skynet.',
  maxTokens: 100,
  timeoutMs: 5000,
  secrets: [SECRET],
  env: { MAGNETAPI_API_KEY: KEY },
};

describe('anonimizzazione per il servizio terzo', () => {
  it('email abbreviate, IP mascherati, segreti cancellati', () => {
    expect(maskEmails('scrive mario.rossi@gmail.com e a@b.it')).toBe(
      'scrive m***@gmail.com e a***@b.it',
    );
    const out = redactForThirdParty(
      `utente luca@solcomusic.online da 203.0.113.77 con ${SECRET} e Bearer abcdefghijklmnopqrstuvwxyz`,
      [SECRET],
    );
    expect(out).toContain('l***@solcomusic.online');
    expect(out).toContain('203.0.x.x');
    expect(out).not.toContain('113.77');
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });
});

describe('gpt6Chat', () => {
  it('manda a MagnetAPI solo testo anonimizzato, con la chiave e senza seguire redirect', async () => {
    const fetchImpl = fakeFetch(200, { choices: [{ message: { content: ' Risposta ' } }] });
    const text = await gpt6Chat({
      ...base,
      messages: [
        { role: 'user', content: `blocco da 198.51.100.9 per anna.verdi@example.com (${SECRET})` },
      ],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(text).toBe('Risposta');
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.magnetapi.org/v1/chat/completions');
    expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${KEY}`);
    const body = String(init.body);
    expect(body).toContain('"model":"gpt-6.2-sol"');
    expect(body).toContain('198.51.x.x');
    expect(body).toContain('a***@example.com');
    expect(body).not.toContain('100.9');
    expect(body).not.toContain('anna.verdi');
    expect(body).not.toContain(SECRET);
  });

  it('senza chiave non chiama nessuno', async () => {
    const fetchImpl = fakeFetch(200, {});
    await expect(
      gpt6Chat({ ...base, env: {}, messages: [], fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('errori, risposte vuote o filtrate e rete giù → null', async () => {
    const run = (fetchImpl: unknown) =>
      gpt6Chat({ ...base, messages: [], fetchImpl: fetchImpl as typeof fetch });
    await expect(run(fakeFetch(401, { error: 'bad key' }))).resolves.toBeNull();
    await expect(
      run(fakeFetch(200, { choices: [{ message: { content: '  ' } }] })),
    ).resolves.toBeNull();
    await expect(
      run(
        fakeFetch(200, {
          choices: [{ message: { content: 'x' }, finish_reason: 'content_filter' }],
        }),
      ),
    ).resolves.toBeNull();
    await expect(
      run(
        vi.fn(async () => {
          throw new TypeError('fetch failed');
        }),
      ),
    ).resolves.toBeNull();
  });
});

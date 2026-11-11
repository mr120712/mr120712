// @polsia:user-owned
// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { POST } from '@/app/api/email-relay/[secret]/send/route';
import { parseRelayPayload, sendWithResend } from '@/lib/email/resend-relay.server';

const SECRET = 'a'.repeat(40);
const email = {
  to: 'listener@example.com',
  subject: 'Benvenuto',
  html: '<p>Ciao</p>',
  body: 'Ciao',
};

function post(secret: string, body: unknown) {
  return POST(
    new Request(`https://solco.test/api/email-relay/${secret}/send`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ secret }) },
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('email con Resend', () => {
  it('rifiuta segreti sbagliati o troppo corti senza inviare nulla', async () => {
    vi.stubEnv('EMAIL_RELAY_SECRET', SECRET);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect((await post('b'.repeat(40), email)).status).toBe(404);
    vi.stubEnv('EMAIL_RELAY_SECRET', 'short');
    expect((await post('short', email)).status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('valida i dati dell’email', () => {
    expect(parseRelayPayload(email)).toMatchObject({ to: 'listener@example.com', text: 'Ciao' });
    expect(parseRelayPayload({ ...email, to: 'non-email' })).toBeNull();
    expect(parseRelayPayload({ ...email, html: '' })).toBeNull();
  });

  it('invia con Resend usando mittente e chiave configurati', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test_key');
    vi.stubEnv('EMAIL_FROM', 'Solco <noreply@solcomusic.app>');
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'msg_1' })));
    const result = await sendWithResend(
      { to: 'a@example.com', subject: 'S', html: '<p>x</p>' },
      fetcher as unknown as typeof fetch,
    );
    expect(result).toEqual({ ok: true, id: 'msg_1' });
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer re_test_key');
    expect(JSON.parse(String(init.body))).toMatchObject({
      from: 'Solco <noreply@solcomusic.app>',
      to: ['a@example.com'],
    });
  });

  it('segnala quando Resend non è configurato', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    expect(await sendWithResend({ to: 'a@example.com', subject: 'S', html: 'x' })).toMatchObject({
      ok: false,
      error: 'email_not_configured',
    });
  });
});

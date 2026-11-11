// @polsia:user-owned
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.SKIP_ENV_VALIDATION = '1';
});
vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: { user: { updateMany: vi.fn() } } }));

import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { safeAuthRedirects } from '@/lib/auth-config';
import {
  allowedRedirectOrigins,
  isSafeAuthRedirect,
  unsafeAuthRedirectField,
} from '@/lib/security/safe-auth-redirect';

const env = {
  BETTER_AUTH_URL: 'https://solcomusic.vercel.app',
  NEXT_PUBLIC_APP_URL: 'https://solcomusic.vercel.app',
  BETTER_AUTH_TRUSTED_ORIGINS: 'https://appleid.apple.com, https://*.polsia.app,https://solco.it',
};

describe('reindirizzamenti dopo accesso e verifica email', () => {
  const origins = allowedRedirectOrigins(env);

  it('accetta solo le origini esatte di Solco, mai i jolly', () => {
    expect([...origins].sort()).toEqual([
      'https://appleid.apple.com',
      'https://solco.it',
      'https://solcomusic.vercel.app',
    ]);
  });

  it.each([
    ['/dashboard', true],
    ['/login?social=error&callbackURL=%2Fdashboard', true],
    ['', true],
    [undefined, true],
    ['https://solcomusic.vercel.app/premi', true],
    ['https://solco.it/', true],
    ['https://altra-app.polsia.app/phish', false],
    ['https://evil.example/', false],
    ['//evil.example/x', false],
    ['/\\evil.example', false],
    ['/\t/evil.example', false],
    ['javascript:alert(1)', false],
    ['https://solcomusic.vercel.app.evil.example/', false],
    [42, false],
  ])('%s → %s', (value, safe) => {
    expect(isSafeAuthRedirect(value, origins)).toBe(safe);
  });

  it('controlla tutti i campi di reindirizzamento nel corpo e nella query', () => {
    expect(unsafeAuthRedirectField([{ callbackURL: '/ok' }, { x: 1 }], origins)).toBeNull();
    expect(
      unsafeAuthRedirectField(
        [{ callbackURL: '/ok', errorCallbackURL: 'https://x.polsia.io/' }],
        origins,
      ),
    ).toBe('errorCallbackURL');
    expect(unsafeAuthRedirectField([undefined, { redirectTo: '//evil' }], origins)).toBe(
      'redirectTo',
    );
  });

  it('better-auth rifiuta con 403 un callbackURL verso un altro sito *.polsia.app', async () => {
    vi.stubEnv('BETTER_AUTH_URL', 'https://solco.test');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://solco.test');
    const auth = betterAuth({
      baseURL: 'https://solco.test',
      secret: 'x'.repeat(40),
      database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
      emailAndPassword: { enabled: true },
      trustedOrigins: ['https://*.polsia.app'],
      plugins: [safeAuthRedirects],
    });
    const signIn = (callbackURL: string) =>
      auth.handler(
        new Request('https://solco.test/api/auth/sign-in/email', {
          method: 'POST',
          headers: { origin: 'https://solco.test', 'content-type': 'application/json' },
          body: JSON.stringify({
            email: 'nessuno@example.test',
            password: 'x'.repeat(12),
            callbackURL,
          }),
        }),
      );
    expect((await signIn('https://altra-app.polsia.app/phish')).status).toBe(403);
    // A safe path reaches the normal sign-in logic (unknown user → 401).
    expect((await signIn('/dashboard')).status).toBe(401);

    const verify = await auth.handler(
      new Request(
        'https://solco.test/api/auth/verify-email?token=bad&callbackURL=https%3A%2F%2Fevil.polsia.app%2F',
      ),
    );
    expect(verify.status).toBe(403);
    vi.unstubAllEnvs();
  });
});

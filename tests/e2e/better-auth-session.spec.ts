// @polsia:framework-owned - DO NOT EDIT. Code installed by polsia/modules/better-auth@0.10.0. Drift = commit rejected.
// Signing up must open a session: a paywall or a protected page right after signup depends on it.
// When this test fails, fix src/lib/auth-config.ts, never this test.

import { randomUUID } from 'node:crypto';
import { type APIRequestContext, type APIResponse, expect, test } from '@playwright/test';

const FIX_HINT =
  'signup must open a session: signing up created no session; check databaseHooks (session.create) and plugins in src/lib/auth-config.ts';

// Reserved TLD: the email proxy rejects it before any send, so QA never mails anyone.
const EMAIL_DOMAIN = 'example.test';

const HTTP_OK = 200;
const HTTP_CLIENT_ERROR = 400;
const HTTP_SERVER_ERROR = 500;
const HTTP_TOO_MANY_REQUESTS = 429;

// better-auth's error code when the user was created but the session was not.
const SESSION_NOT_CREATED = 'FAILED_TO_CREATE_SESSION';

const MAX_SIGN_UP_ATTEMPTS = 3;
const DEFAULT_RETRY_AFTER_SECONDS = 10;
const MS_PER_SECOND = 1000;

/** Signs up, waiting out better-auth's sign-up rate limit (3 per 10 s) shared with other specs. */
async function signUp(
  request: APIRequestContext,
  origin: string,
  email: string,
): Promise<APIResponse> {
  let response = await postSignUp(request, origin, email);
  for (let attempt = 1; attempt < MAX_SIGN_UP_ATTEMPTS; attempt++) {
    if (response.status() !== HTTP_TOO_MANY_REQUESTS) {
      return response;
    }

    const retryAfter = Number(response.headers()['x-retry-after']) || DEFAULT_RETRY_AFTER_SECONDS;
    await new Promise((resolve) => setTimeout(resolve, retryAfter * MS_PER_SECOND));
    response = await postSignUp(request, origin, email);
  }
  return response;
}

/**
 * True when the app itself refuses this signup (email/password off, invite-only hook, captcha,
 * required extra field): an app policy, not a broken session. Rate limiting is not a refusal,
 * and neither is better-auth failing to create the session (the case this spec guards).
 */
function refusedByApp(status: number, answer: string): boolean {
  if (status < HTTP_CLIENT_ERROR || status >= HTTP_SERVER_ERROR) {
    return false;
  }
  if (status === HTTP_TOO_MANY_REQUESTS) {
    return false;
  }
  return !answer.includes(SESSION_NOT_CREATED);
}

function postSignUp(
  request: APIRequestContext,
  origin: string,
  email: string,
): Promise<APIResponse> {
  return request.post('/api/auth/sign-up/email', {
    headers: { origin },
    data: { email, password: `Qa-${randomUUID()}`, name: 'QA Session Check' },
  });
}

test('signing up opens a session', async ({ request, baseURL }) => {
  const origin = new URL(baseURL ?? 'http://localhost:3000').origin;
  const email = `qa-${randomUUID()}@${EMAIL_DOMAIN}`;

  const response = await signUp(request, origin, email);
  const answer = await response.text();
  test.skip(refusedByApp(response.status(), answer), `the app refuses this signup: ${answer}`);

  expect(response.status(), `${FIX_HINT}. Sign-up answered: ${answer}`).toBe(HTTP_OK);

  const session = await request.get('/api/auth/get-session', { headers: { origin } });
  const body = (await session.json().catch(() => null)) as { user?: { email?: string } } | null;
  expect(body?.user?.email, FIX_HINT).toBe(email);
});

// @vitest-environment node
import { randomBytes } from 'node:crypto';
import { config as loadDotEnv } from 'dotenv';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const sendEmailMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/email/send', () => ({ sendEmail: sendEmailMock }));
vi.mock('server-only', () => ({}));

loadDotEnv({ path: resolve(process.cwd(), '.env') });

const testRunId = randomBytes(6).toString('hex');
const ownerEmail = `solco-owner-${testRunId}@example.test`;
const targetEmail = `bestmr12-target-${testRunId}@example.test`;
const memberEmail = `solco-member-${testRunId}@example.test`;
const password = `Synthetic-${randomBytes(18).toString('hex')}-Password!`;
const origin = 'http://localhost:3000';

vi.stubEnv('POLSIA_OWNER_EMAIL', ownerEmail);
vi.stubEnv('ADMIN_USER_ID', '');
vi.stubEnv('BETTER_AUTH_URL', origin);
vi.stubEnv('BETTER_AUTH_SECRET', randomBytes(32).toString('hex'));
vi.stubEnv('NEXT_PUBLIC_APP_URL', origin);

let auth: typeof import('@/lib/auth').auth;
let prisma: typeof import('@/lib/db').prisma;

beforeAll(async () => {
  ({ auth } = await import('@/lib/auth'));
  ({ prisma } = await import('@/lib/db'));
  sendEmailMock.mockResolvedValue({ id: 'synthetic-verification-email' });
});

afterAll(async () => {
  if (prisma) {
    await prisma.user.deleteMany({
      where: { email: { in: [ownerEmail, targetEmail, memberEmail] } },
    });
    await prisma.$disconnect();
  }
  vi.unstubAllEnvs();
});

async function register(email: string, claimedRole?: string, name = 'Account di prova') {
  const body = {
    name,
    email,
    password,
    callbackURL: '/dashboard',
    ...(claimedRole ? { role: claimedRole } : {}),
  };
  return auth.handler(
    new Request(`${origin}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
      },
      body: JSON.stringify(body),
    }),
  );
}

async function expectSuccessfulSignup(response: Response) {
  const body = (await response.clone().text()).replaceAll(password, '[credenziale sintetica oscurata]');
  expect(response.status, body).toBe(200);
}

function sessionCookie(response: Response) {
  const raw = response.headers.get('set-cookie');
  const match = raw?.match(/(?:^|,\s*)(?:__Secure-)?better-auth\.session_token=[^;,\s]+/);
  if (!match) throw new Error('La registrazione non ha impostato il cookie di sessione');
  return match[0].replace(/^,\s*/, '');
}

async function readSession(cookie: string) {
  const response = await auth.handler(
    new Request(`${origin}/api/auth/get-session`, {
      headers: { cookie },
    }),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as { user?: { role?: string; emailVerified?: boolean } } | null;
}

function verificationURLFromLastEmail() {
  const message: unknown = sendEmailMock.mock.calls.at(-1)?.[0];
  if (!message || typeof message !== 'object' || !('text' in message)) {
    throw new Error('Il messaggio sintetico non contiene il testo della verifica');
  }

  const match = String(message.text).match(/https?:\/\/\S+/);
  if (!match) throw new Error('Il messaggio sintetico non contiene un link di verifica');
  return new URL(match[0]);
}

async function verifyEmail() {
  const url = verificationURLFromLastEmail();
  expect(url.pathname).toBe('/api/auth/verify-email');

  return auth.handler(
    new Request(url, {
      headers: { origin },
    }),
  );
}

describe('flusso di bootstrap admin con verifica email sintetica', () => {
  it('applica il ruolo admin del titolare Polsia solo dopo la verifica email', async () => {
    const response = await register(ownerEmail);
    await expectSuccessfulSignup(response);
    const cookie = sessionCookie(response);

    const responseBody = await response.clone().text();
    expect(responseBody).not.toContain(password);
    expect(sendEmailMock).toHaveBeenCalled();

    const sessionBeforeVerification = await readSession(cookie);
    expect(sessionBeforeVerification?.user?.role).toBe('user');
    expect(sessionBeforeVerification?.user?.emailVerified).toBe(false);

    const beforeVerification = await prisma.user.findUnique({ where: { email: ownerEmail } });
    expect(beforeVerification?.emailVerified).toBe(false);
    expect(beforeVerification?.role).toBe('user');

    const verified = await verifyEmail();
    expect([200, 302, 303]).toContain(verified.status);

    const afterVerification = await prisma.user.findUnique({ where: { email: ownerEmail } });
    expect(afterVerification?.emailVerified).toBe(true);
    expect(afterVerification?.role).toBe('admin');

    const sessionAfterVerification = await readSession(cookie);
    expect(sessionAfterVerification?.user?.role).toBe('admin');
    expect(sessionAfterVerification?.user?.emailVerified).toBe(true);
  });

  it('promuove l’ID server designato solo dopo aver seguito il link di verifica', async () => {
    vi.stubEnv('ADMIN_USER_ID', '');
    const response = await register(targetEmail, undefined, 'bestmr12');
    await expectSuccessfulSignup(response);
    const cookie = sessionCookie(response);

    const storedUser = await prisma.user.findUnique({ where: { email: targetEmail } });
    expect(storedUser).not.toBeNull();
    if (!storedUser) throw new Error('Account sintetico non persistito');
    vi.stubEnv('ADMIN_USER_ID', storedUser.id);

    const verified = await verifyEmail();
    expect([200, 302, 303]).toContain(verified.status);

    const target = await prisma.user.findUnique({ where: { email: targetEmail } });
    expect(target?.emailVerified).toBe(true);
    expect(target?.role).toBe('admin');
    expect((await readSession(cookie))?.user?.role).toBe('admin');
  });

  it('mantiene utente un indirizzo diverso anche con un ruolo admin inviato dal client', async () => {
    vi.stubEnv('ADMIN_USER_ID', '');
    const forgedSignup = await register(memberEmail, 'admin');
    expect(forgedSignup.status).toBe(400);
    const forgedBody = (await forgedSignup.text()).replaceAll(password, '[credenziale sintetica oscurata]');
    expect(forgedBody).toContain('FIELD_NOT_ALLOWED');

    const response = await register(memberEmail);
    await expectSuccessfulSignup(response);
    const cookie = sessionCookie(response);

    const verified = await verifyEmail();
    expect([200, 302, 303]).toContain(verified.status);

    const member = await prisma.user.findUnique({ where: { email: memberEmail } });
    expect(member?.emailVerified).toBe(true);
    expect(member?.role).toBe('user');
    expect((await readSession(cookie))?.user?.role).toBe('user');
  });
});

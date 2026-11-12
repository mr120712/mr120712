import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CookieJar } from '../src/cookies.js';

test('CookieJar: tiene i cookie e costruisce l’header', () => {
  const jar = new CookieJar();
  jar.applySetCookie('session=abc123; Path=/; HttpOnly; SameSite=Lax');
  jar.applySetCookie('other=zzz; Path=/');
  assert.equal(jar.header(), 'session=abc123; other=zzz');
});

test('CookieJar: Max-Age=0 cancella il cookie', () => {
  const jar = new CookieJar({ session: 'abc' });
  jar.applySetCookie('session=; Max-Age=0; Path=/');
  assert.equal(jar.header(), null);
});

test('CookieJar: cookie scaduto non viene inviato', () => {
  const now = 1_000_000;
  const jar = new CookieJar();
  jar.applySetCookie('session=abc; Max-Age=10', now);
  assert.equal(jar.header(now + 5_000), 'session=abc');
  assert.equal(jar.header(now + 20_000), null);
});

test('CookieJar: absorb usa getSetCookie quando disponibile', () => {
  const jar = new CookieJar();
  const headers = {
    getSetCookie: () => ['a=1; Path=/', 'b=2; Path=/'],
    get: () => null,
  } as unknown as Headers;
  jar.absorb(headers);
  assert.deepEqual(jar.toJSON(), { a: '1', b: '2' });
});

test('CookieJar: absorb spezza un header Set-Cookie concatenato con Expires', () => {
  const jar = new CookieJar();
  const single = 'a=1; Expires=Wed, 21 Oct 2099 07:28:00 GMT; Path=/, b=2; Path=/; HttpOnly';
  const headers = {
    get: (name: string) => (name.toLowerCase() === 'set-cookie' ? single : null),
  } as unknown as Headers;
  jar.absorb(headers);
  assert.deepEqual(jar.toJSON(), { a: '1', b: '2' });
});

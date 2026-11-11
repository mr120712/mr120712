// A frozen-then-resumed sandbox keeps pool connections whose TCP flow is gone.
// This proxy reproduces that: it stops forwarding on every open socket without
// closing it, so a query sent on one never gets an answer. The test checks that
// Prisma's `max_idle_connection_lifetime` (set by src/lib/db.ts) makes the next
// query open a fresh connection instead of waiting on a dead one.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { after, before, test } from 'node:test';
// biome-ignore lint/style/noRestrictedImports: a Node integration test that drives Prisma against a real database.
import { PrismaClient } from '@prisma/client';

assert.ok(
  process.env.TEST_DATABASE_URL,
  'Set TEST_DATABASE_URL to a disposable PostgreSQL database',
);
const target = new URL(process.env.TEST_DATABASE_URL);

const dbSource = readFileSync(new URL('../../src/lib/db.ts', import.meta.url), 'utf8');
const lifetime = Number(/MAX_IDLE_CONNECTION_LIFETIME_SECONDS = (\d+);/.exec(dbSource)?.[1]);
assert.ok(lifetime > 0, 'src/lib/db.ts must declare MAX_IDLE_CONNECTION_LIFETIME_SECONDS');

const sockets = new Set();
const proxy = net.createServer((client) => {
  const upstream = net.connect(Number(target.port || 5432), target.hostname);
  const flow = { frozen: false };
  sockets.add(flow);
  client.on('data', (chunk) => {
    if (!flow.frozen) upstream.write(chunk);
  });
  upstream.on('data', (chunk) => {
    if (!flow.frozen) client.write(chunk);
  });
  const close = () => {
    sockets.delete(flow);
    client.destroy();
    upstream.destroy();
  };
  for (const socket of [client, upstream]) {
    socket.on('error', close);
    socket.on('close', close);
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freezeOpenSockets() {
  for (const flow of sockets) flow.frozen = true;
}

function proxiedUrl(extra) {
  const url = new URL(target);
  url.hostname = '127.0.0.1';
  url.port = String(proxy.address().port);
  url.searchParams.set('connection_limit', '3');
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
  return url.href;
}

/** Fills the pool, freezes its sockets, waits, then times one query. */
async function queryAfterFreeze(extra, idleMs) {
  const prisma = new PrismaClient({ datasourceUrl: proxiedUrl(extra) });
  try {
    await Promise.all([0, 1, 2].map(() => prisma.$queryRaw`select pg_sleep(0.2)::text`));
    freezeOpenSockets();
    await sleep(idleMs);
    const answered = prisma.$queryRaw`select 1::int as ok`.then(() => true);
    return await Promise.race([answered, sleep(4_000).then(() => false)]);
  } finally {
    prisma.$disconnect().catch(() => {});
  }
}

before(() => new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve)));
after(() => {
  for (const flow of sockets) flow.frozen = true;
  proxy.close();
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
});

test('without an idle limit, a query after the freeze hangs on a dead connection', async () => {
  assert.equal(await queryAfterFreeze({}, (lifetime + 1) * 1000), false);
});

test('with the template idle limit, a query after the freeze uses a fresh connection', async () => {
  const extra = { max_idle_connection_lifetime: String(lifetime) };
  assert.equal(await queryAfterFreeze(extra, (lifetime + 1) * 1000), true);
});

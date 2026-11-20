// @polsia:user-owned — gate di collegamento Telegram: codice casuale url-safe, creazione della
// sfida (monouso, invalida le precedenti) e consumo (monouso, scadenza, formato). Store Prisma finto.
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  consumeTelegramLinkChallenge,
  createTelegramLinkChallenge,
  generateTelegramLinkCode,
  isValidTelegramLinkCode,
  LINK_CODE_TTL_MS,
  type LinkChallengeStore,
} from '@/lib/business/telegram-link';

function store(
  deleteImpl?: () => Promise<{ userId: string; expiresAt: Date }>,
): LinkChallengeStore & {
  calls: { deleteMany: unknown[]; create: unknown[]; delete: unknown[] };
} {
  const calls = { deleteMany: [] as unknown[], create: [] as unknown[], delete: [] as unknown[] };
  return {
    calls,
    telegramLinkChallenge: {
      deleteMany: vi.fn(async (args) => {
        calls.deleteMany.push(args);
        return { count: 0 };
      }),
      create: vi.fn(async (args) => {
        calls.create.push(args);
        return {};
      }),
      delete: vi.fn(async (args) => {
        calls.delete.push(args);
        if (!deleteImpl) throw new Error('not found');
        return deleteImpl();
      }),
    },
  };
}

describe('generateTelegramLinkCode', () => {
  it('32 caratteri url-safe (A-Za-z0-9_-), entro il limite di 64 di Telegram, e unici', () => {
    const a = generateTelegramLinkCode();
    const b = generateTelegramLinkCode();
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(a.length).toBeLessThanOrEqual(64);
    expect(a).not.toBe(b);
  });
});

describe('isValidTelegramLinkCode', () => {
  it('accetta un codice generato; rifiuta vuoto, punto, troppo corto/lungo, spazi', () => {
    expect(isValidTelegramLinkCode(generateTelegramLinkCode())).toBe(true);
    expect(isValidTelegramLinkCode('')).toBe(false);
    expect(isValidTelegramLinkCode('ha.punto')).toBe(false);
    expect(isValidTelegramLinkCode('corto')).toBe(false);
    expect(isValidTelegramLinkCode('a'.repeat(65))).toBe(false);
    expect(isValidTelegramLinkCode('con spazio')).toBe(false);
  });
});

describe('createTelegramLinkChallenge', () => {
  it('invalida i codici pendenti dell’utente, ne crea uno nuovo con scadenza e lo ritorna', async () => {
    const db = store();
    const code = await createTelegramLinkChallenge(db, 'user-1', 1000);
    expect(code).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(db.calls.deleteMany).toEqual([{ where: { userId: 'user-1' } }]);
    expect(db.calls.create).toEqual([
      { data: { code, userId: 'user-1', expiresAt: new Date(1000 + LINK_CODE_TTL_MS) } },
    ]);
  });
});

describe('consumeTelegramLinkChallenge', () => {
  it('codice valido e non scaduto → userId, cancellando la riga (monouso)', async () => {
    const db = store(async () => ({ userId: 'user-9', expiresAt: new Date(10_000) }));
    const code = generateTelegramLinkCode();
    expect(await consumeTelegramLinkChallenge(db, code, 5_000)).toBe('user-9');
    expect(db.calls.delete).toEqual([{ where: { code } }]);
  });

  it('codice scaduto → null', async () => {
    const db = store(async () => ({ userId: 'user-9', expiresAt: new Date(1_000) }));
    expect(await consumeTelegramLinkChallenge(db, generateTelegramLinkCode(), 5_000)).toBeNull();
  });

  it('codice inesistente/già usato (delete lancia) → null', async () => {
    const db = store(); // delete lancia
    expect(await consumeTelegramLinkChallenge(db, generateTelegramLinkCode())).toBeNull();
  });

  it('formato non valido → null senza toccare il DB', async () => {
    const db = store(async () => ({ userId: 'x', expiresAt: new Date(Date.now() + 10_000) }));
    expect(await consumeTelegramLinkChallenge(db, 'ha.punto')).toBeNull();
    expect(db.calls.delete).toEqual([]);
  });
});

// @polsia:user-owned
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  configured: true,
  channel: '@solcomusic' as string | undefined,
  send: vi.fn(),
  create: vi.fn(),
}));

vi.mock('@/lib/env', () => ({
  get env() {
    return { TELEGRAM_CHANNEL_CHAT_ID: mocks.channel };
  },
}));
vi.mock('@/lib/business/telegram-bot.server', () => ({
  isTelegramBotConfigured: () => mocks.configured,
  sendTelegramMessage: mocks.send,
}));
vi.mock('@/lib/db', () => ({
  prisma: { buildAnnouncement: { create: mocks.create } },
}));

import {
  announceBuildIfNew,
  buildAnnouncementText,
  isBuildAnnouncementConfigured,
  redactSecrets,
} from '@/lib/business/build-announcement.server';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.configured = true;
  mocks.channel = '@solcomusic';
  mocks.send.mockResolvedValue(true);
  mocks.create.mockResolvedValue({ id: 'x' });
  process.env.VERCEL_GIT_COMMIT_SHA = 'abc1234567890';
  process.env.VERCEL_GIT_COMMIT_MESSAGE = 'Aggiunge la ricerca live dei brani';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('redactSecrets', () => {
  it('oscura coppie chiave: valore sensibili', () => {
    expect(redactSecrets('token: 123abc')).toBe('token: •••');
    expect(redactSecrets('api_key=supersegreto')).toBe('api_key: •••');
    expect(redactSecrets('password = hunter2')).toBe('password: •••');
  });

  it('oscura credenziali in un URL', () => {
    expect(redactSecrets('postgres://utente:pwd@host/db')).toBe('postgres://•••@host/db');
  });

  it('oscura blob lunghi tipo hash/token ma lascia il testo normale', () => {
    // Hash esadecimale lungo → oscurato.
    expect(redactSecrets('deploy 0123456789abcdef0123456789abcdef')).toBe('deploy •••');
    // Stringa con trattini/underscore lunga → oscurata.
    expect(redactSecrets('chiave ghp_ABCDEFGHIJKLMNOPQRSTUV')).toBe('chiave •••');
    // Parole italiane normali → intatte.
    expect(redactSecrets('Aggiunge la ricerca live dei brani')).toBe(
      'Aggiunge la ricerca live dei brani',
    );
  });
});

describe('buildAnnouncementText', () => {
  it('usa solo la prima riga del messaggio e la versione breve', () => {
    const text = buildAnnouncementText(
      'abc1234567890',
      'Aggiunge la ricerca live\n\nCo-Authored-By: Qualcuno <x@y.z>\nClaude-Session: https://esempio',
    );
    expect(text).toContain('Aggiunge la ricerca live');
    expect(text).toContain('(versione abc1234)');
    // Non trapela il corpo del commit (trailer / link di sessione).
    expect(text).not.toContain('Co-Authored-By');
    expect(text).not.toContain('Claude-Session');
    expect(text).not.toContain('esempio');
  });

  it('fallback quando il messaggio è vuoto', () => {
    expect(buildAnnouncementText('abc1234', '')).toContain('Nuovo aggiornamento');
  });
});

describe('isBuildAnnouncementConfigured', () => {
  it('true solo con bot e canale', () => {
    expect(isBuildAnnouncementConfigured()).toBe(true);
    mocks.channel = undefined;
    expect(isBuildAnnouncementConfigured()).toBe(false);
    mocks.channel = '@solcomusic';
    mocks.configured = false;
    expect(isBuildAnnouncementConfigured()).toBe(false);
  });
});

describe('announceBuildIfNew', () => {
  it('non fa nulla senza commit sha (fuori da Vercel)', async () => {
    // In Node `process.env.X = undefined` salva la stringa "undefined": va rimossa davvero.
    Reflect.deleteProperty(process.env, 'VERCEL_GIT_COMMIT_SHA');
    await announceBuildIfNew();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('non fa nulla se non configurato', async () => {
    mocks.channel = undefined;
    await announceBuildIfNew();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('registra la build e pubblica sul canale', async () => {
    await announceBuildIfNew();
    expect(mocks.create).toHaveBeenCalledWith({ data: { commitSha: 'abc1234567890' } });
    expect(mocks.send).toHaveBeenCalledWith('@solcomusic', expect.stringContaining('abc1234'));
  });

  it('se la build è già annunciata (unique) non ripubblica', async () => {
    mocks.create.mockRejectedValue(new Error('Unique constraint failed'));
    await announceBuildIfNew();
    expect(mocks.create).toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('non lancia se l’invio fallisce', async () => {
    mocks.send.mockRejectedValue(new Error('rete'));
    await expect(announceBuildIfNew()).resolves.toBeUndefined();
    expect(mocks.create).toHaveBeenCalled();
  });
});

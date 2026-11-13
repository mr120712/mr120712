// @polsia:user-owned
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  configured: true,
  channel: '@solcomusic' as string | undefined,
  send: vi.fn(),
  create: vi.fn(),
  upsert: vi.fn(),
  findUnique: vi.fn(),
  delete: vi.fn(),
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
  prisma: {
    buildAnnouncement: {
      create: mocks.create,
      upsert: mocks.upsert,
      findUnique: mocks.findUnique,
      delete: mocks.delete,
    },
  },
}));

// biome-ignore lint/style/noRestrictedImports: serve l'errore Prisma reale per testare l'instanceof.
import { Prisma } from '@prisma/client';
import {
  announceBuildIfNew,
  announcementPreview,
  buildAnnouncementText,
  isBuildAnnouncementConfigured,
  publishAnnouncementNow,
  redactSecrets,
} from '@/lib/business/build-announcement.server';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.configured = true;
  mocks.channel = '@solcomusic';
  mocks.send.mockResolvedValue(true);
  mocks.create.mockResolvedValue({ id: 'x' });
  mocks.upsert.mockResolvedValue({ id: 'x' });
  mocks.findUnique.mockResolvedValue(null);
  mocks.delete.mockResolvedValue({ id: 'x' });
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

  it('oscura token base62 puri senza separatori (≥24)', () => {
    // Nessun separatore, non esadecimale: la variante precedente lo lasciava passare.
    expect(redactSecrets('Rotate prod token aB3dEfGh1jKlMn2pQrSt3uVw')).toBe(
      'Rotate prod token •••',
    );
  });

  it('oscura segreti base64 con + / = (un unico blob)', () => {
    // Chiave segreta stile AWS: + e / spezzavano il run sotto i 24 caratteri nella variante vecchia.
    expect(redactSecrets('oops committed wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY')).toBe(
      'oops committed •••',
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

  it('senza sha omette la riga della versione', () => {
    const text = buildAnnouncementText('', 'Aggiornamento manuale');
    expect(text).toContain('Aggiornamento manuale');
    expect(text).not.toContain('versione');
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

  it('se la build è già annunciata (P2002 unique) non ripubblica e non rilancia', async () => {
    mocks.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '6.19.3',
      }),
    );
    await expect(announceBuildIfNew()).resolves.toBeUndefined();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it('un errore DB transitorio (non P2002) viene rilanciato, non scambiato per dedup', async () => {
    mocks.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('pool timeout', {
        code: 'P2024',
        clientVersion: '6.19.3',
      }),
    );
    await expect(announceBuildIfNew()).rejects.toThrow();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('se l’invio ritorna false rilascia il claim (un boot futuro potrà ritentare)', async () => {
    mocks.send.mockResolvedValue(false);
    await expect(announceBuildIfNew()).resolves.toBeUndefined();
    expect(mocks.create).toHaveBeenCalled();
    expect(mocks.delete).toHaveBeenCalledWith({ where: { commitSha: 'abc1234567890' } });
  });

  it('se l’invio lancia, non propaga e rilascia il claim', async () => {
    mocks.send.mockRejectedValue(new Error('rete'));
    await expect(announceBuildIfNew()).resolves.toBeUndefined();
    expect(mocks.delete).toHaveBeenCalled();
  });
});

describe('publishAnnouncementNow', () => {
  it('pubblica sul canale e registra il commit (upsert) anche se già annunciato', async () => {
    const result = await publishAnnouncementNow();
    expect(result.posted).toBe(true);
    expect(result.reason).toBe('ok');
    expect(mocks.send).toHaveBeenCalledWith('@solcomusic', expect.stringContaining('abc1234'));
    // upsert, non create: una ripubblicazione non deve fallire su commit già presente.
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { commitSha: 'abc1234567890' } }),
    );
  });

  it('riferisce bot non configurato senza inviare', async () => {
    mocks.configured = false;
    const result = await publishAnnouncementNow();
    expect(result).toMatchObject({ posted: false, reason: 'bot_not_configured' });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('riferisce canale non configurato senza inviare', async () => {
    mocks.channel = undefined;
    const result = await publishAnnouncementNow();
    expect(result).toMatchObject({ posted: false, reason: 'channel_not_configured' });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('se Telegram rifiuta, reason=telegram_failed e non registra', async () => {
    mocks.send.mockResolvedValue(false);
    const result = await publishAnnouncementNow();
    expect(result).toMatchObject({ posted: false, reason: 'telegram_failed' });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});

describe('announcementPreview', () => {
  it('riporta stato configurazione, testo e se già annunciato', async () => {
    mocks.findUnique.mockResolvedValue({ id: 'x' });
    const preview = await announcementPreview();
    expect(preview).toMatchObject({
      botConfigured: true,
      channelConfigured: true,
      commitShort: 'abc1234',
      alreadyAnnounced: true,
    });
    expect(preview.preview).toContain('abc1234');
  });

  it('non lancia se la lettura dal DB fallisce', async () => {
    mocks.findUnique.mockRejectedValue(new Error('db'));
    const preview = await announcementPreview();
    expect(preview.alreadyAnnounced).toBe(false);
  });
});

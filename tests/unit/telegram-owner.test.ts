// @polsia:user-owned — gate «owner del bot»: ID esplicito, oppure account amministratore collegato col
// codice monouso (+ username come secondo fattore opzionale). Database finto, nessuna rete.
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  findLink: vi.fn(),
  findUser: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    telegramAccountLink: { findUnique: mocks.findLink },
    user: { findUnique: mocks.findUser },
  },
}));

import { checkTelegramOwner, ownerTelegramUsernames } from '@/lib/business/telegram-owner.server';

const admin = { role: 'admin', emailVerified: true };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findLink.mockResolvedValue({ userId: 'u1' });
  mocks.findUser.mockResolvedValue(admin);
});

describe('ownerTelegramUsernames', () => {
  it('normalizza: senza @, minuscolo, separatori e virgolette tollerati; scarta i non validi', () => {
    expect(
      ownerTelegramUsernames({
        SKYNET_TELEGRAM_OWNER_USERNAMES: ' @Solco_music; "Altro_Nome" , ab ',
      }),
    ).toEqual(['solco_music', 'altro_nome']);
    expect(ownerTelegramUsernames({})).toEqual([]);
  });
});

describe('checkTelegramOwner', () => {
  it('ID esplicito in SKYNET_TELEGRAM_CHAT_IDS → owner, senza toccare il database', async () => {
    expect(await checkTelegramOwner('123', null, { SKYNET_TELEGRAM_CHAT_IDS: '123' })).toEqual({
      owner: true,
      via: 'chat-id',
    });
    expect(mocks.findLink).not.toHaveBeenCalled();
  });

  it('chat collegata a un amministratore verificato → owner', async () => {
    expect(await checkTelegramOwner('123', 'chiunque', {})).toEqual({
      owner: true,
      via: 'admin-link',
    });
    expect(mocks.findLink).toHaveBeenCalledWith({
      where: { telegramChatId: '123' },
      select: { userId: true },
    });
  });

  it('chat non collegata → non owner', async () => {
    mocks.findLink.mockResolvedValue(null);
    expect(await checkTelegramOwner('123', 'Solco_music', {})).toEqual({
      owner: false,
      reason: 'not-linked',
    });
    expect(mocks.findUser).not.toHaveBeenCalled();
  });

  it('collegata a un utente normale, a un admin senza email verificata o a un utente sparito → non owner', async () => {
    for (const user of [
      { role: 'user', emailVerified: true },
      { role: 'admin', emailVerified: false },
      { role: null, emailVerified: true },
      null,
    ]) {
      mocks.findUser.mockResolvedValue(user);
      expect(await checkTelegramOwner('123', 'Solco_music', {})).toEqual({
        owner: false,
        reason: 'not-admin',
      });
    }
  });

  it('secondo fattore: con gli username fissati, l’admin collegato deve anche scrivere da quello username', async () => {
    const env = { SKYNET_TELEGRAM_OWNER_USERNAMES: '@Solco_music' };
    expect((await checkTelegramOwner('123', 'solco_MUSIC', env)).owner).toBe(true);
    for (const username of ['un_altro_account', null]) {
      expect(await checkTelegramOwner('123', username, env)).toEqual({
        owner: false,
        reason: 'username-mismatch',
      });
    }
  });

  it('lo username da solo non basta mai: giusto username ma nessun account admin collegato', async () => {
    mocks.findLink.mockResolvedValue(null);
    const env = { SKYNET_TELEGRAM_OWNER_USERNAMES: 'Solco_music' };
    expect((await checkTelegramOwner('999', 'Solco_music', env)).owner).toBe(false);
  });

  it('errore del database → fail-closed (nessun accesso)', async () => {
    mocks.findLink.mockRejectedValue(new Error('db down'));
    expect(await checkTelegramOwner('123', 'Solco_music', {})).toEqual({
      owner: false,
      reason: 'unavailable',
    });
  });
});

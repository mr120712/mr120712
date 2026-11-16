// @polsia:user-owned
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  premium: vi.fn(async () => false),
  user: vi.fn(async () => null as { id: string } | null),
  plays: [] as Array<{ userId: string; qualifiedId: string; month: string; createdAt: Date }>,
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/business/premium-access.server', () => ({ hasPremiumAccess: mocks.premium }));
vi.mock('@/lib/require-auth', () => ({ getSessionUser: mocks.user }));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: () => true }));
vi.mock('@/lib/db', () => ({
  prisma: {
    musicPlay: {
      count: vi.fn(
        async ({
          where,
        }: {
          where: {
            userId: string;
            month: string;
            NOT?: Array<{ qualifiedId: { startsWith: string } }>;
            qualifiedId?: { startsWith: string };
          };
        }) =>
          mocks.plays.filter(
            (p) =>
              p.userId === where.userId &&
              p.month === where.month &&
              (!where.qualifiedId || p.qualifiedId.startsWith(where.qualifiedId.startsWith)) &&
              !(where.NOT ?? []).some((rule) =>
                p.qualifiedId.startsWith(rule.qualifiedId.startsWith),
              ),
          ).length,
      ),
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: { userId: string; qualifiedId: string; createdAt: { gt: Date } };
        }) =>
          mocks.plays.find(
            (p) =>
              p.userId === where.userId &&
              p.qualifiedId === where.qualifiedId &&
              p.createdAt > where.createdAt.gt,
          ) ?? null,
      ),
      create: vi.fn(
        async ({ data }: { data: { userId: string; qualifiedId: string; month: string } }) => {
          const row = { createdAt: new Date(), ...data };
          mocks.plays.push(row);
          return row;
        },
      ),
    },
    // consumePlay reads and writes in one Serializable transaction (concurrency: play-quota-concurrency).
    $transaction(run: (transaction: unknown) => Promise<unknown>) {
      return run(this);
    },
  },
}));

import { POST as playsRoute } from '@/app/api/music/plays/route';
import {
  countsTowardFreeQuota,
  decidePlay,
  FEATURED_FREE_MONTHLY_PLAYS,
  FREE_MONTHLY_PLAYS,
  freeMonthlyLimit,
  isValidPlayId,
  permitRecordsPlay,
  playQuotaClass,
  romeMonth,
} from '@/lib/business/play-quota';
import { consumePlay, monthlyPlays } from '@/lib/business/play-quota.server';

beforeEach(() => {
  mocks.plays.length = 0;
  mocks.premium.mockReset().mockResolvedValue(false);
});
afterEach(() => vi.unstubAllEnvs());

describe('limite di ascolti per gli account free', () => {
  it('gli ospiti devono accedere, Premium è illimitato', () => {
    expect(
      decidePlay({ signedIn: false, premium: false, usedThisMonth: 0, recentSameTrack: false }),
    ).toMatchObject({
      allowed: false,
      reason: 'login_required',
    });
    expect(
      decidePlay({ signedIn: true, premium: true, usedThisMonth: 500, recentSameTrack: false }),
    ).toMatchObject({
      allowed: true,
      limit: null,
    });
  });

  it('blocca il 41° ascolto del mese e non conta le riprese dello stesso brano', async () => {
    const user = { id: 'free-user' };
    const now = new Date('2026-11-20T10:00:00Z');
    for (let i = 0; i < FREE_MONTHLY_PLAYS; i += 1) {
      const decision = await consumePlay(user, `audius:track${1000 + i}`, now);
      expect(decision.allowed).toBe(true);
    }
    // Same track again within 30 minutes: allowed, not counted.
    expect(await consumePlay(user, 'audius:track1039', now)).toMatchObject({
      allowed: true,
      counted: false,
    });
    expect(await consumePlay(user, 'podcast:123~episode-1', now)).toMatchObject({
      allowed: false,
      reason: 'monthly_limit',
      used: 40,
    });
    // A new month resets the count.
    const nextMonth = new Date('2026-12-01T10:00:00Z');
    expect(romeMonth(nextMonth)).toBe('2026-12');
    expect(await consumePlay(user, 'podcast:123~episode-1', nextMonth)).toMatchObject({
      allowed: true,
      used: 1,
    });
  });

  it('i video YouTube non contano e non vengono mai bloccati (norme YouTube)', async () => {
    const user = { id: 'yt-user' };
    const now = new Date('2026-11-20T10:00:00Z');
    for (let i = 0; i < FREE_MONTHLY_PLAYS; i += 1) {
      await consumePlay(user, `audius:track${2000 + i}`, now);
    }
    // A stale YouTube row from before the exemption is ignored by the monthly count.
    mocks.plays.push({
      userId: user.id,
      qualifiedId: 'youtube:oldvideo000',
      month: romeMonth(now),
      createdAt: now,
    });
    expect(await consumePlay(user, 'audius:another', now)).toMatchObject({
      allowed: false,
      used: 40,
    });
    expect(await consumePlay(user, 'youtube:dQw4w9WgXcQ', now)).toMatchObject({
      allowed: true,
      counted: false,
      used: 40,
    });
    expect(mocks.plays.filter((p) => p.qualifiedId === 'youtube:dQw4w9WgXcQ')).toHaveLength(0);
    // Guests still need an account.
    expect(await consumePlay(null, 'youtube:dQw4w9WgXcQ', now)).toMatchObject({
      allowed: false,
      reason: 'login_required',
    });
  });

  it('le radio dal vivo non contano e non vengono mai bloccate, ma serve un account', async () => {
    const user = { id: 'radio-user' };
    const now = new Date('2026-11-20T10:00:00Z');
    expect(countsTowardFreeQuota('radio:station-1')).toBe(false);
    expect(countsTowardFreeQuota('youtube:dQw4w9WgXcQ')).toBe(false);
    expect(countsTowardFreeQuota('audius:track')).toBe(true);
    expect(countsTowardFreeQuota('podcast:1~ep')).toBe(true);
    for (let i = 0; i < FREE_MONTHLY_PLAYS; i += 1) {
      await consumePlay(user, `podcast:${3000 + i}~ep`, now);
    }
    // A stale radio row from before the exemption is ignored by the monthly count.
    mocks.plays.push({
      userId: user.id,
      qualifiedId: 'radio:old-station',
      month: romeMonth(now),
      createdAt: now,
    });
    expect(await monthlyPlays(user.id, now)).toBe(40);
    expect(await consumePlay(user, 'radio:new-station', now)).toMatchObject({
      allowed: true,
      counted: false,
      used: 40,
      limit: FREE_MONTHLY_PLAYS,
    });
    expect(mocks.plays.filter((p) => p.qualifiedId === 'radio:new-station')).toHaveLength(0);
    // Guests still need an account.
    expect(await consumePlay(null, 'radio:new-station', now)).toMatchObject({
      allowed: false,
      reason: 'login_required',
    });
  });

  it('Jamendo spento (manca la licenza commerciale) non consuma ascolti Free', async () => {
    vi.stubEnv('JAMENDO_CLIENT_ID', 'jamendo-id');
    vi.stubEnv('JAMENDO_COMMERCIAL_LICENSE', '');
    const user = { id: 'jamendo-user' };
    const now = new Date();
    for (let i = 0; i < FREE_MONTHLY_PLAYS; i += 1) {
      await consumePlay(user, `audius:track${4000 + i}`, now);
    }
    // A saved Jamendo track (library, queue, history) asks the player's permit first.
    mocks.user.mockResolvedValueOnce(user);
    const response = await playsRoute(
      new Request('https://solco.test/api/music/plays', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ qualifiedId: 'jamendo:1532771' }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ allowed: true, used: 40, limit: FREE_MONTHLY_PLAYS });
    expect(mocks.plays.filter((p) => p.qualifiedId.startsWith('jamendo:'))).toHaveLength(0);

    // With the commercial licence confirmed, Jamendo counts like Audius and podcasts.
    vi.stubEnv('JAMENDO_COMMERCIAL_LICENSE', 'confirmed');
    expect(await consumePlay(user, 'jamendo:1532771', now)).toMatchObject({
      allowed: false,
      reason: 'monthly_limit',
    });
    expect(await consumePlay({ id: 'fresh-user' }, 'jamendo:1532771', now)).toMatchObject({
      allowed: true,
      counted: true,
      used: 1,
    });
  });

  it('Premium non registra ascolti e accetta solo id validi', async () => {
    mocks.premium.mockResolvedValue(true);
    expect(await consumePlay({ id: 'paid' }, 'audius:paid-track')).toMatchObject({
      allowed: true,
      counted: false,
    });
    expect(mocks.plays).toHaveLength(0);
    expect(isValidPlayId('youtube:dQw4w9WgXcQ')).toBe(true);
    expect(isValidPlayId('youtube:../../etc')).toBe(false);
  });
});

describe('brani di audio.com (audiocom:<id>) nel limite Free', () => {
  it('id valido solo con l’id numerico di audio.com; l’id storico upload:audiocom~ no', () => {
    expect(isValidPlayId('audiocom:123')).toBe(true);
    expect(isValidPlayId(`audiocom:${'9'.repeat(24)}`)).toBe(true);
    for (const invalid of [
      'audiocom:',
      'audiocom:abc',
      'audiocom:12a',
      `audiocom:${'9'.repeat(25)}`,
      'audiocom:../1',
      'upload:audiocom~123',
    ]) {
      expect(isValidPlayId(invalid), invalid).toBe(false);
    }
  });

  it('contano come Audius e podcast; gli upload pubblici restano esclusi', () => {
    expect(countsTowardFreeQuota('audiocom:123')).toBe(true);
    expect(countsTowardFreeQuota(`upload:${'c'.repeat(25)}`)).toBe(false);
    expect(countsTowardFreeQuota('upload:audiocom~123')).toBe(false);
  });

  it('solo per audio.com il permesso del player registra l’ascolto', () => {
    expect(permitRecordsPlay('audiocom:123')).toBe(true);
    for (const other of [
      'audius:track',
      'podcast:1~ep',
      'radio:station-1',
      'youtube:dQw4w9WgXcQ',
      'jamendo:1532771',
      `upload:${'c'.repeat(25)}`,
      'upload:audiocom~123',
    ]) {
      expect(permitRecordsPlay(other), other).toBe(false);
    }
  });

  it('il 41° ascolto del mese di audio.com è bloccato; riascoltare entro 30 minuti non conta', async () => {
    const user = { id: 'audiocom-user' };
    const now = new Date('2026-11-20T10:00:00Z');
    for (let i = 0; i < FREE_MONTHLY_PLAYS - 1; i += 1) {
      expect((await consumePlay(user, `audius:track${5000 + i}`, now)).allowed).toBe(true);
    }
    expect(await consumePlay(user, 'audiocom:111', now)).toMatchObject({
      allowed: true,
      counted: true,
      used: FREE_MONTHLY_PLAYS,
    });
    expect(await consumePlay(user, 'audiocom:111', now)).toMatchObject({
      allowed: true,
      counted: false,
    });
    expect(await consumePlay(user, 'audiocom:222', now)).toMatchObject({
      allowed: false,
      reason: 'monthly_limit',
      used: FREE_MONTHLY_PLAYS,
    });
    expect(mocks.plays.filter((p) => p.qualifiedId.startsWith('audiocom:'))).toHaveLength(1);
    expect(await consumePlay(null, 'audiocom:222', now)).toMatchObject({
      allowed: false,
      reason: 'login_required',
    });
  });
});

describe('brani in evidenza (upload:<pathname>): conteggio Free a parte, 30 avvii al mese', () => {
  const featured = 'upload:Pop/Autrice - Canzone.mp3';
  const permit = (qualifiedId: string) =>
    playsRoute(
      new Request('https://solco.test/api/music/plays', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ qualifiedId }),
      }),
    );
  const featuredRows = () => mocks.plays.filter((p) => p.qualifiedId.startsWith('upload:'));

  it('si riconoscono dal pathname: gli upload pubblici (cuid) e l’id storico di audio.com restano esenti', () => {
    expect(playQuotaClass(featured)).toBe('featured');
    expect(playQuotaClass('upload:a.mp3')).toBe('featured');
    expect(playQuotaClass(`upload:${'c'.repeat(25)}`)).toBe('exempt');
    expect(playQuotaClass('upload:audiocom~123')).toBe('exempt');
    expect(playQuotaClass('upload:public-uploads/x.mp3')).toBe('exempt');
    expect(playQuotaClass('youtube:dQw4w9WgXcQ')).toBe('exempt');
    expect(playQuotaClass('radio:station-1')).toBe('exempt');
    expect(playQuotaClass('audius:track')).toBe('catalog');
    expect(playQuotaClass('podcast:1~ep')).toBe('catalog');
    expect(playQuotaClass('audiocom:123')).toBe('catalog');
    expect(freeMonthlyLimit('featured')).toBe(FEATURED_FREE_MONTHLY_PLAYS);
    expect(freeMonthlyLimit('catalog')).toBe(FREE_MONTHLY_PLAYS);
    expect(FEATURED_FREE_MONTHLY_PLAYS).toBe(30);

    expect(countsTowardFreeQuota(featured)).toBe(true);
    // La route di stream dei brani in evidenza registra l'ascolto: il permesso verifica soltanto.
    expect(permitRecordsPlay(featured)).toBe(false);
    expect(isValidPlayId(featured)).toBe(true);
    expect(isValidPlayId('upload:Rock/mia canzone.M4A')).toBe(true);
    for (const invalid of [
      `upload:${'c'.repeat(25)}`,
      'upload:audiocom~123',
      'upload:public-uploads/x.mp3',
      'upload:../x.mp3',
      'upload:/x.mp3',
      'upload:diritti.json',
      'upload:',
    ]) {
      expect(isValidPlayId(invalid), invalid).toBe(false);
    }
  });

  it('decidePlay con il tetto di 30: il 31° avvio è bloccato', () => {
    const base = { signedIn: true, premium: false, recentSameTrack: false, limit: 30 };
    expect(decidePlay({ ...base, usedThisMonth: 29 })).toEqual({
      allowed: true,
      counted: true,
      used: 30,
      limit: 30,
    });
    expect(decidePlay({ ...base, usedThisMonth: 30 })).toEqual({
      allowed: false,
      reason: 'monthly_limit',
      used: 30,
      limit: 30,
    });
    expect(decidePlay({ ...base, usedThisMonth: 30, recentSameTrack: true })).toMatchObject({
      allowed: true,
      counted: false,
      limit: 30,
    });
    expect(decidePlay({ ...base, signedIn: false, usedThisMonth: 0 })).toEqual({
      allowed: false,
      reason: 'login_required',
      used: 0,
      limit: 30,
    });
  });

  it('il 31° brano in evidenza del mese è bloccato; i 40 ascolti del catalogo non c’entrano', async () => {
    const user = { id: 'featured-user' };
    const now = new Date('2026-11-20T10:00:00Z');
    // Il catalogo è già esaurito: non tocca i brani in evidenza.
    for (let i = 0; i < FREE_MONTHLY_PLAYS; i += 1) {
      expect((await consumePlay(user, `audius:track${7000 + i}`, now)).allowed).toBe(true);
    }
    expect(await consumePlay(user, 'audius:track-extra', now)).toMatchObject({
      allowed: false,
      reason: 'monthly_limit',
      limit: FREE_MONTHLY_PLAYS,
    });
    for (let i = 0; i < FEATURED_FREE_MONTHLY_PLAYS; i += 1) {
      expect(await consumePlay(user, `upload:Pop/brano-${i}.mp3`, now)).toMatchObject({
        allowed: true,
        counted: true,
        used: i + 1,
        limit: FEATURED_FREE_MONTHLY_PLAYS,
      });
    }
    expect(await consumePlay(user, featured, now)).toEqual({
      allowed: false,
      reason: 'monthly_limit',
      used: FEATURED_FREE_MONTHLY_PLAYS,
      limit: FEATURED_FREE_MONTHLY_PLAYS,
    });
    // Riprendere uno dei 30 entro la finestra di riascolto: ammesso, non contato.
    expect(await consumePlay(user, 'upload:Pop/brano-3.mp3', now)).toMatchObject({
      allowed: true,
      counted: false,
      used: FEATURED_FREE_MONTHLY_PLAYS,
    });
    expect(featuredRows()).toHaveLength(FEATURED_FREE_MONTHLY_PLAYS);
    // Il conteggio del catalogo non è cambiato per i 30 avvii in evidenza.
    expect(await consumePlay(user, 'audius:track-extra', now)).toMatchObject({
      allowed: false,
      used: FREE_MONTHLY_PLAYS,
    });
    // Nuovo mese: si riparte.
    expect(await consumePlay(user, featured, new Date('2026-12-01T10:00:00Z'))).toMatchObject({
      allowed: true,
      used: 1,
      limit: FEATURED_FREE_MONTHLY_PLAYS,
    });
  });

  it('ospite: accesso richiesto con il tetto dei brani in evidenza; Premium senza limite e senza righe', async () => {
    expect(await consumePlay(null, featured)).toEqual({
      allowed: false,
      reason: 'login_required',
      used: 0,
      limit: FEATURED_FREE_MONTHLY_PLAYS,
    });
    mocks.premium.mockResolvedValue(true);
    expect(await consumePlay({ id: 'paid' }, featured)).toEqual({
      allowed: true,
      counted: false,
      used: 0,
      limit: null,
    });
    expect(mocks.plays).toHaveLength(0);
  });

  it('il permesso del player verifica soltanto (200 senza righe) e rifiuta con 402 oltre i 30', async () => {
    mocks.user.mockResolvedValue({ id: 'featured-user' });
    const ok = await permit(featured);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ allowed: true, used: 1, limit: FEATURED_FREE_MONTHLY_PLAYS });
    expect(featuredRows()).toHaveLength(0);

    const month = romeMonth(new Date());
    for (let i = 0; i < FEATURED_FREE_MONTHLY_PLAYS; i += 1) {
      mocks.plays.push({
        userId: 'featured-user',
        qualifiedId: `upload:Pop/brano-${i}.mp3`,
        month,
        createdAt: new Date(Date.now() - 3_600_000),
      });
    }
    const blocked = await permit(featured);
    expect(blocked.status).toBe(402);
    expect(await blocked.json()).toEqual({
      allowed: false,
      reason: 'monthly_limit',
      used: FEATURED_FREE_MONTHLY_PLAYS,
      limit: FEATURED_FREE_MONTHLY_PLAYS,
    });
    // Un brano Audius segue il suo conteggio: libero.
    expect(await (await permit('audius:still-free')).json()).toEqual({
      allowed: true,
      used: 1,
      limit: FREE_MONTHLY_PLAYS,
    });
    // Un upload pubblico non è un id del permesso.
    expect((await permit(`upload:${'c'.repeat(25)}`)).status).toBe(400);
  });
});

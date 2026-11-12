// @polsia:user-owned — cronologia di ascolto: le voci YouTube invecchiano da quando YouTube ha
// inviato i dati (data stabilita dal server), mai dall'ultimo ascolto.
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Fetch = { userId: string; qualifiedId: string; fetchedAt: Date };
type History = {
  id: string;
  userId: string;
  qualifiedId: string;
  title: string;
  playCount: number;
};
type SearchRow = {
  createdAt: Date;
  payload: { videos: Array<{ videoId: string }>; checkedAt?: string };
};

const db = vi.hoisted(() => {
  const fetches = new Map<string, Fetch>();
  const history = new Map<string, History>();
  const searches: SearchRow[] = [];
  const songs: Array<{ videoId: string | null; createdAt: Date }> = [];
  const items: Array<{ source: string; sourceId: string; expiresAt: Date | null }> = [];
  const key = (userId: string, qualifiedId: string) => `${userId}|${qualifiedId}`;
  return {
    fetches,
    history,
    searches,
    songs,
    items,
    key,
    reset() {
      fetches.clear();
      history.clear();
      searches.length = 0;
      songs.length = 0;
      items.length = 0;
    },
  };
});

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => {
  type Where = { userId_qualifiedId: { userId: string; qualifiedId: string } };
  const prisma = {
    youTubeHistoryFetch: {
      findUnique: vi.fn(async ({ where }: { where: Where }) => {
        const { userId, qualifiedId } = where.userId_qualifiedId;
        return db.fetches.get(db.key(userId, qualifiedId)) ?? null;
      }),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: Where;
          create: Fetch;
          update: Partial<Fetch>;
        }) => {
          const { userId, qualifiedId } = where.userId_qualifiedId;
          const id = db.key(userId, qualifiedId);
          const row = db.fetches.get(id);
          db.fetches.set(id, row ? { ...row, ...update } : create);
        },
      ),
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { userId: string; qualifiedId: { in: string[] }; fetchedAt: { gt: Date } };
        }) =>
          [...db.fetches.values()].filter(
            (row) =>
              row.userId === where.userId &&
              where.qualifiedId.in.includes(row.qualifiedId) &&
              row.fetchedAt > where.fetchedAt.gt,
          ),
      ),
      deleteMany: vi.fn(
        async ({ where }: { where: { userId?: string; fetchedAt?: { lte: Date } } }) => {
          let count = 0;
          for (const [id, row] of db.fetches) {
            if (where.userId && row.userId !== where.userId) continue;
            if (where.fetchedAt && row.fetchedAt > where.fetchedAt.lte) continue;
            db.fetches.delete(id);
            count += 1;
          }
          return { count };
        },
      ),
    },
    youTubeSearchCache: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { payload: { path: string[]; array_contains: Array<{ videoId: string }> } };
        }) => {
          const wanted = where.payload.array_contains[0]?.videoId;
          return db.searches.filter((row) =>
            row.payload.videos.some((video) => video.videoId === wanted),
          );
        },
      ),
    },
    songResolution: {
      findFirst: vi.fn(async ({ where }: { where: { videoId: string } }) => {
        const rows = db.songs
          .filter((row) => row.videoId === where.videoId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        return rows[0] ?? null;
      }),
    },
    userMusicCollectionItem: {
      findFirst: vi.fn(async ({ where }: { where: { sourceId: string } }) => {
        const rows = db.items
          .filter((row) => row.source === 'youtube' && row.sourceId === where.sourceId)
          .filter((row) => row.expiresAt !== null)
          .sort((a, b) => (a.expiresAt?.getTime() ?? 0) - (b.expiresAt?.getTime() ?? 0));
        return rows[0] ? { expiresAt: rows[0].expiresAt } : null;
      }),
    },
    userPlaybackHistory: {
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: Where;
          create: { userId: string; qualifiedId: string; title: string };
          update: { title: string };
        }) => {
          const { userId, qualifiedId } = where.userId_qualifiedId;
          const id = db.key(userId, qualifiedId);
          const row = db.history.get(id);
          db.history.set(
            id,
            row
              ? { ...row, title: update.title, playCount: row.playCount + 1 }
              : {
                  id,
                  userId: create.userId,
                  qualifiedId: create.qualifiedId,
                  title: create.title,
                  playCount: 1,
                },
          );
        },
      ),
      findMany: vi.fn(async ({ where, skip = 0 }: { where: { userId: string }; skip?: number }) =>
        [...db.history.values()]
          .filter((row) => row.userId === where.userId)
          .slice(skip)
          .map((row) => ({
            ...row,
            playbackMode: 'youtube',
            artistName: 'Canale',
            artworkUrl: null,
            sourceLabel: 'YouTube',
            sourceUrl: null,
            albumId: null,
            durationSeconds: null,
            lastPlayedAt: new Date('2026-11-12T10:00:00Z'),
          })),
      ),
      deleteMany: vi.fn(async ({ where }: { where: { userId: string; id?: { in: string[] } } }) => {
        for (const [id, row] of db.history) {
          if (row.userId !== where.userId) continue;
          if (where.id && !where.id.in.includes(row.id)) continue;
          db.history.delete(id);
        }
        return { count: 0 };
      }),
    },
    // The cleanup's plain SQL: YouTube entries without a date are removed.
    $executeRaw: vi.fn(async () => {
      let count = 0;
      for (const [id, row] of db.history) {
        if (row.qualifiedId.startsWith('youtube:') && !db.fetches.has(id)) {
          db.history.delete(id);
          count += 1;
        }
      }
      return count;
    }),
  };
  const empty = () => ({ findMany: vi.fn(async () => []) });
  return {
    prisma: {
      ...prisma,
      userSavedStation: empty(),
      userPodcastFollow: empty(),
      userMusicFolder: empty(),
      userMusicCollection: empty(),
      userHiddenItem: empty(),
    },
  };
});

import { applyLibraryMutation, getLibrary } from '@/lib/music/library.server';
import {
  deleteExpiredYouTubeHistory,
  YOUTUBE_HISTORY_MAX_AGE_MS,
  youtubeDataFetchedAt,
} from '@/lib/music/youtube-history.server';

const DAY = 24 * 60 * 60 * 1000;
const VIDEO = 'dQw4w9WgXcQ';
const QUALIFIED = `youtube:${VIDEO}`;

function play(title = 'Caruso', qualifiedId = QUALIFIED) {
  return applyLibraryMutation('user-1', {
    action: 'record_play',
    track: {
      qualifiedId,
      title,
      artistName: 'Lucio Dalla',
      artworkUrl: null,
      sourceLabel: 'YouTube',
      sourceUrl: null,
      albumId: null,
      durationSeconds: null,
      playbackMode: 'youtube',
    },
  });
}

beforeEach(() => {
  db.reset();
  vi.useRealTimers();
});

describe('cronologia YouTube: età dei dati', () => {
  it('data i dati con la copia più vecchia che il server conserva del video', async () => {
    const now = new Date('2026-11-12T10:00:00Z');
    // No copy at all: the age is unknown, so the date is the cutoff (not shown).
    expect(await youtubeDataFetchedAt(VIDEO, now)).toEqual(
      new Date(now.getTime() - YOUTUBE_HISTORY_MAX_AGE_MS),
    );
    db.searches.push({ createdAt: now, payload: { videos: [{ videoId: VIDEO }] } });
    expect(await youtubeDataFetchedAt(VIDEO, now)).toEqual(now);
    db.searches.length = 0;
    // A saved search from 20 days ago (re-checked 2 days ago), a matched song from 25 days ago.
    db.searches.push({
      createdAt: new Date(now.getTime() - 20 * DAY),
      payload: {
        videos: [{ videoId: VIDEO }],
        checkedAt: new Date(now.getTime() - 2 * DAY).toISOString(),
      },
    });
    expect(await youtubeDataFetchedAt(VIDEO, now)).toEqual(new Date(now.getTime() - 2 * DAY));
    db.songs.push({ videoId: VIDEO, createdAt: new Date(now.getTime() - 25 * DAY) });
    expect(await youtubeDataFetchedAt(VIDEO, now)).toEqual(new Date(now.getTime() - 25 * DAY));
    // A collection item whose metadata (29 days) expires in 2 days was fetched 27 days ago.
    db.items.push({
      source: 'youtube',
      sourceId: VIDEO,
      expiresAt: new Date(now.getTime() + 2 * DAY),
    });
    expect(await youtubeDataFetchedAt(VIDEO, now)).toEqual(new Date(now.getTime() - 27 * DAY));
  });

  it('un riascolto non sposta mai la data: la voce sparisce 28 giorni dopo l’invio da YouTube', async () => {
    vi.useFakeTimers();
    const start = new Date('2026-11-01T10:00:00Z');
    vi.setSystemTime(start);
    // Played from a saved search YouTube sent 27 days ago.
    db.searches.push({
      createdAt: new Date(start.getTime() - 27 * DAY),
      payload: { videos: [{ videoId: VIDEO }] },
    });
    await play();
    expect(db.fetches.get(db.key('user-1', QUALIFIED))?.fetchedAt).toEqual(
      new Date(start.getTime() - 27 * DAY),
    );
    expect((await getLibrary('user-1')).history).toHaveLength(1);

    // Replayed two days later: the date stays, so the entry is no longer shown…
    vi.setSystemTime(new Date(start.getTime() + 2 * DAY));
    await play('Caruso (live)');
    expect(db.fetches.get(db.key('user-1', QUALIFIED))?.fetchedAt).toEqual(
      new Date(start.getTime() - 27 * DAY),
    );
    expect((await getLibrary('user-1')).history).toHaveLength(0);

    // …and the daily cleanup deletes it together with its date.
    await deleteExpiredYouTubeHistory(new Date());
    expect(db.history.size).toBe(0);
    expect(db.fetches.size).toBe(0);
  });

  it('le voci YouTube senza data (salvate prima) vengono nascoste e cancellate; le altre restano', async () => {
    const now = new Date();
    db.history.set(db.key('user-1', QUALIFIED), {
      id: 'old',
      userId: 'user-1',
      qualifiedId: QUALIFIED,
      title: 'Vecchia',
      playCount: 9,
    });
    await play('Radio Prova', 'radio:station-1');
    const shown = (await getLibrary('user-1')).history.map((entry) => entry.qualifiedId);
    expect(shown).toEqual(['radio:station-1']);
    const removed = await deleteExpiredYouTubeHistory(now);
    expect(removed.count).toBe(1);
    expect([...db.history.values()].map((row) => row.qualifiedId)).toEqual(['radio:station-1']);
    expect(YOUTUBE_HISTORY_MAX_AGE_MS).toBe(28 * DAY);
  });

  it('senza nessuna copia sul server la voce non viene mostrata (dati forse vecchi)', async () => {
    vi.useFakeTimers();
    const start = new Date('2026-11-01T10:00:00Z');
    vi.setSystemTime(start);
    // A title restored from a queue the browser kept for weeks: the search rows are gone.
    await play('Titolo di 40 giorni fa');
    expect((await getLibrary('user-1')).history).toHaveLength(0);
    await deleteExpiredYouTubeHistory(new Date());
    expect(db.history.size).toBe(0);

    // Played again from a new search: dated by that search, and shown.
    db.searches.push({ createdAt: start, payload: { videos: [{ videoId: VIDEO }] } });
    vi.setSystemTime(new Date(start.getTime() + DAY));
    await play();
    expect(db.fetches.get(db.key('user-1', QUALIFIED))?.fetchedAt).toEqual(start);
    expect((await getLibrary('user-1')).history).toHaveLength(1);
  });

  it('cancellare la cronologia cancella anche le date', async () => {
    await play();
    expect(db.fetches.size).toBe(1);
    await applyLibraryMutation('user-1', { action: 'clear_history' });
    expect(db.history.size).toBe(0);
    expect(db.fetches.size).toBe(0);
  });
});

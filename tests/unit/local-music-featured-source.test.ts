// @polsia:user-owned — la libreria sul dispositivo come FONTE DI VERITÀ delle copie offline dei
// "brani in evidenza": la fonte 'featured-download' resta nel record a ogni riscrittura
// (setTrackDuration); un record che una versione precedente ha riscritto come 'local' si rilegge
// come copia grazie alla sua chiave ESATTA; un file dell'ascoltatore non si scambia mai per una
// copia, qualunque nome abbia; la chiave del download si espone solo per i download; e il testo
// di una copia non si legge mai dai tag del file. La fonte persa torna anche SUL DISCO con
// repairFeaturedCopySources (il player non riscrive mai da solo un record che ha già la durata);
// e il download di una fonte che questa versione non conosce non si legge affatto, invece di
// passare per un file dell'ascoltatore ed essere riscritto. Database in memoria, come gli altri
// test della libreria.
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  downloadSourceKey,
  featuredCopyShareId,
  isFeaturedCopySourceKey,
  isUnknownDownloadSourceKey,
  readDownloadSourceKey,
} from '@/lib/local-music/download-key';
import {
  LOCAL_MUSIC_DB_NAME,
  type LocalMusicDb,
  type LocalMusicStoreName,
  type LocalMusicWrite,
  localMusicDbExists,
} from '@/lib/local-music/idb';
import { loadLocalLyrics } from '@/lib/local-music/lyrics';
import type { DurationProbe } from '@/lib/local-music/media';
import { createLocalMusicReader, hasDownloadedTrack } from '@/lib/local-music/reader';
import { createLocalMusicStore } from '@/lib/local-music/store';
import { emptyTags } from '@/lib/local-music/types';

const ID_A = 'AbCdEfGhIjKlMnOpQrSt_-';
const ID_B = 'BBBBBBBBBBBBBBBBBBBBBB';
const FEATURED_KEY = `featured:${ID_A}`;

class MemoryDb implements LocalMusicDb {
  data: Record<LocalMusicStoreName, Map<string, unknown>> = {
    tracks: new Map(),
    files: new Map(),
    artwork: new Map(),
  };
  /** Gli store letti con get(), in ordine: dice se un file audio è stato aperto. */
  reads: LocalMusicStoreName[] = [];
  /** Le chiavi scritte in 'tracks', in ordine: dice se un record è stato riscritto. */
  trackWrites: string[] = [];

  async get(store: LocalMusicStoreName, key: string) {
    this.reads.push(store);
    return this.data[store].get(key);
  }
  async getAll(store: LocalMusicStoreName) {
    return [...this.data[store].values()];
  }
  async write(ops: readonly LocalMusicWrite[]) {
    for (const op of ops) {
      if (op.store === 'tracks' && op.op === 'put') this.trackWrites.push(op.key);
      if (op.op === 'put') this.data[op.store].set(op.key, op.value);
      else this.data[op.store].delete(op.key);
    }
  }
  async update(store: LocalMusicStoreName, key: string, fn: (current: unknown) => unknown) {
    const current = this.data[store].get(key);
    if (current === undefined) return;
    const next = fn(current);
    if (next !== undefined) await this.write([{ op: 'put', store, key, value: next }]);
  }
  async clear(stores: readonly LocalMusicStoreName[]) {
    for (const store of stores) this.data[store].clear();
  }
}

/** La libreria con un database in memoria; la durata non si riesce a leggere (come su iOS). */
function makeStore() {
  const db = new MemoryDb();
  let ids = 0;
  let clock = 1_000;
  const store = createLocalMusicStore({
    db,
    canPlayType: (mime) => (mime === 'audio/mpeg' ? 'maybe' : ''),
    readTags: async () => emptyTags(),
    probeDuration: async (): Promise<DurationProbe> => ({ seconds: null, timedOut: false }),
    getStorage: () => undefined,
    now: () => {
      clock += 10;
      return clock;
    },
    randomId: () => {
      ids += 1;
      return `id-${ids}`;
    },
  });
  return { store, db };
}

const attribution = {
  sourceName: 'Solco · In evidenza',
  sourceUrl: null,
  licenseName: 'Creative Commons Attribuzione (CC BY)',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/deed.it',
  creditLine: '© Banda di prova',
};

function featuredDownload(overrides: Record<string, unknown> = {}) {
  return {
    blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/mpeg' }),
    downloadKey: FEATURED_KEY,
    source: 'featured-download' as const,
    title: 'Brano concesso',
    artist: 'Banda di prova',
    album: null,
    durationSeconds: null,
    mimeType: 'audio/mpeg',
    attribution,
    ...overrides,
  };
}

function audioFile(name: string, { size = 1000, lastModified = 1 } = {}) {
  return new File([new Uint8Array(size)], name, { type: 'audio/mpeg', lastModified });
}

function rawRecord(db: MemoryDb, id: string): Record<string, unknown> {
  return db.data.tracks.get(id) as Record<string, unknown>;
}

/**
 * Quello che faceva la versione precedente (commit a97851c): rileggeva la fonte che non conosceva
 * come 'local' e, salvando la durata dal player, riscriveva il record così.
 */
function rewriteLikeTheOldVersion(db: MemoryDb, id: string) {
  db.data.tracks.set(id, { ...rawRecord(db, id), source: 'local', durationSeconds: 187 });
}

// Un tag ID3v2.3 con un frame USLT: il file porta un testo incorporato (testo di prova).
const latin1 = (value: string) => [...value].map((char) => char.charCodeAt(0) & 0xff);
const be32 = (value: number) => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];
const syncsafe = (value: number) => [
  (value >> 21) & 0x7f,
  (value >> 14) & 0x7f,
  (value >> 7) & 0x7f,
  value & 0x7f,
];
function audioWithEmbeddedLyrics(text: string): Blob {
  const data = [3, ...latin1('ita'), 0, ...new TextEncoder().encode(text)];
  const frame = [...latin1('USLT'), ...be32(data.length), 0, 0, ...data];
  return new Blob(
    [
      new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, ...syncsafe(frame.length), ...frame]),
      new Uint8Array(2000),
    ],
    { type: 'audio/mpeg' },
  );
}

describe('fonte "featured-download": resta nel record', () => {
  it('sopravvive a setTrackDuration, con chiave e attribuzione', async () => {
    const { store, db } = makeStore();
    const added = await store.addDownloadedTrack(featuredDownload());
    expect(added).toMatchObject({ ok: true, track: { id: 'id-1', source: 'featured-download' } });
    expect(rawRecord(db, 'id-1')).toMatchObject({
      source: 'featured-download',
      sourceKey: downloadSourceKey('featured-download', FEATURED_KEY),
      durationSeconds: null,
    });

    // Il player conosce la durata quando il brano suona e la salva: il record viene riscritto.
    await store.setTrackDuration('id-1', 187.2);

    expect(rawRecord(db, 'id-1')).toMatchObject({
      source: 'featured-download',
      sourceKey: downloadSourceKey('featured-download', FEATURED_KEY),
      durationSeconds: 187.2,
      attribution,
    });
    const expected = {
      id: 'id-1',
      durationSeconds: 187.2,
      source: 'featured-download',
      downloadKey: FEATURED_KEY,
      attribution,
    };
    expect(await store.getTrack('id-1')).toMatchObject(expected);
    expect((await store.listTracks())[0]).toMatchObject(expected);
    // Lo stesso lettore che usa il player (reader.ts), su un'altra istanza.
    expect(await createLocalMusicReader(db).getTrack('id-1')).toMatchObject(expected);
  });

  it('record già riscritto come "local" da una versione precedente: riletto come copia e riparato', async () => {
    const { store, db } = makeStore();
    await store.addDownloadedTrack(featuredDownload());
    rewriteLikeTheOldVersion(db, 'id-1');
    expect(rawRecord(db, 'id-1').source).toBe('local');

    // In lettura è di nuovo una copia di un brano in evidenza, con la sua chiave e i suoi crediti.
    const healed = {
      id: 'id-1',
      source: 'featured-download',
      downloadKey: FEATURED_KEY,
      attribution,
    };
    expect(await store.getTrack('id-1')).toMatchObject(healed);
    expect((await store.listTracks())[0]).toMatchObject(healed);

    // Una scrittura che avviene davvero (una durata diversa) rimette la fonte anche sul disco…
    await store.setTrackDuration('id-1', 200);
    expect(rawRecord(db, 'id-1')).toMatchObject({ source: 'featured-download', attribution });
    expect(rawRecord(db, 'id-1').durationSeconds).toBe(200);
  });

  it('…ma il player non riscrive un record che ha già la durata: sul disco resta "local" finché non lo si ripara', async () => {
    const { store, db } = makeStore();
    await store.addDownloadedTrack(featuredDownload());
    rewriteLikeTheOldVersion(db, 'id-1');
    db.trackWrites = [];

    // È quello che fa il player (rememberLocalDuration): al più la stessa durata, mai un'altra.
    await store.setTrackDuration('id-1', 187);
    await store.setTrackDuration('id-1', 187.3);
    expect(db.trackWrites).toEqual([]);
    expect(rawRecord(db, 'id-1').source).toBe('local');

    // La riparazione rimette la fonte sul disco, e solo quella.
    const before = rawRecord(db, 'id-1');
    expect(await store.repairFeaturedCopySources()).toBe(1);
    expect(db.trackWrites).toEqual(['id-1']);
    expect(rawRecord(db, 'id-1')).toEqual({ ...before, source: 'featured-download' });
    // Fatta una volta, non c'è più nulla da riscrivere.
    expect(await store.repairFeaturedCopySources()).toBe(0);
    expect(db.trackWrites).toEqual(['id-1']);
  });

  it('la chiave esatta resta la regola anche dopo la riparazione (una scheda vecchia può rifare il danno)', async () => {
    const { store, db } = makeStore();
    await store.addDownloadedTrack(featuredDownload());
    rewriteLikeTheOldVersion(db, 'id-1');
    await store.repairFeaturedCopySources();
    // Una scheda rimasta aperta con la versione precedente riscrive di nuovo il record.
    rewriteLikeTheOldVersion(db, 'id-1');
    expect(await store.getTrack('id-1')).toMatchObject({
      source: 'featured-download',
      downloadKey: FEATURED_KEY,
    });
  });

  it('la chiave esatta basta anche senza il campo source o con una fonte sconosciuta', async () => {
    const { store, db } = makeStore();
    await store.addDownloadedTrack(featuredDownload());
    const record = rawRecord(db, 'id-1');
    for (const source of [undefined, null, 'sconosciuta', 42, 'audius-download']) {
      db.data.tracks.set('id-1', { ...record, source });
      expect(await store.getTrack('id-1')).toMatchObject({
        source: 'featured-download',
        downloadKey: FEATURED_KEY,
      });
    }
  });
});

describe('repairFeaturedCopySources: la fonte persa torna sul disco', () => {
  it('ripara solo le copie in evidenza con la fonte sbagliata; tutto il resto non viene nemmeno riscritto', async () => {
    const { store, db } = makeStore();
    // id-1: file dell'ascoltatore con un nome che imita la chiave; id-2: file salvato da una
    // versione senza il campo `source`; id-3 Audius; id-4 podcast; id-5 copia sana; id-6 e id-7
    // copie danneggiate (fonte 'local' e fonte assente).
    await store.addFiles([
      audioFile(`featured:${ID_A}.mp3`),
      audioFile('vecchio.mp3', { size: 7 }),
    ]);
    const { source: _dropped, attribution: _alsoDropped, ...legacy } = rawRecord(db, 'id-2');
    db.data.tracks.set('id-2', legacy);
    await store.addDownloadedTrack(
      featuredDownload({ source: 'audius-download', downloadKey: 'trk-1' }),
    );
    await store.addDownloadedTrack(
      featuredDownload({ source: 'podcast-download', downloadKey: '99~ep-7' }),
    );
    await store.addDownloadedTrack(featuredDownload());
    await store.addDownloadedTrack(featuredDownload({ downloadKey: `featured:${ID_B}` }));
    await store.addDownloadedTrack(featuredDownload({ downloadKey: `featured:${'C'.repeat(22)}` }));
    rewriteLikeTheOldVersion(db, 'id-6');
    const { source: _lost, ...withoutSource } = rawRecord(db, 'id-7');
    db.data.tracks.set('id-7', withoutSource);
    const before = new Map([...db.data.tracks].map(([id, row]) => [id, { ...(row as object) }]));
    db.trackWrites = [];

    expect(await store.repairFeaturedCopySources()).toBe(2);

    expect(db.trackWrites.sort()).toEqual(['id-6', 'id-7']);
    for (const id of ['id-1', 'id-2', 'id-3', 'id-4', 'id-5']) {
      expect(rawRecord(db, id), id).toEqual(before.get(id));
    }
    expect(rawRecord(db, 'id-6')).toEqual({ ...before.get('id-6'), source: 'featured-download' });
    expect(rawRecord(db, 'id-7')).toEqual({ ...before.get('id-7'), source: 'featured-download' });
    // I file dell'ascoltatore restano file dell'ascoltatore.
    expect((await store.getTrack('id-1'))?.source).toBeUndefined();
    expect((await store.getTrack('id-2'))?.source).toBeUndefined();
  });

  it('cambia solo la fonte: gli altri campi, anche quelli che questa versione non conosce, restano', async () => {
    const { store, db } = makeStore();
    await store.addDownloadedTrack(featuredDownload());
    db.data.tracks.set('id-1', {
      ...rawRecord(db, 'id-1'),
      source: 'local',
      durationSeconds: 187,
      campoFuturo: { versione: 2 },
    });
    expect(await store.repairFeaturedCopySources()).toBe(1);
    expect(rawRecord(db, 'id-1')).toMatchObject({
      source: 'featured-download',
      durationSeconds: 187,
      campoFuturo: { versione: 2 },
      attribution,
      sourceKey: downloadSourceKey('featured-download', FEATURED_KEY),
    });
  });

  it('un brano tolto nel frattempo non ricompare, e una libreria vuota non fa nulla', async () => {
    const { store, db } = makeStore();
    expect(await store.repairFeaturedCopySources()).toBe(0);
    await store.addDownloadedTrack(featuredDownload());
    rewriteLikeTheOldVersion(db, 'id-1');
    // Tolto fra la lettura dell'elenco e la riscrittura.
    const getAll = db.getAll.bind(db);
    db.getAll = async (name) => {
      const rows = await getAll(name);
      await store.removeTrack('id-1');
      return rows;
    };
    expect(await store.repairFeaturedCopySources()).toBe(0);
    expect(db.data.tracks.has('id-1')).toBe(false);
  });
});

describe('download di una fonte che questa versione non conosce', () => {
  const PARTNER_KEY = JSON.stringify(['download', 'partner-download', 'p:123']);

  /** Un record come lo scriverebbe una versione più recente, con una fonte nuova. */
  function seedPartnerDownload(db: MemoryDb, overrides: Record<string, unknown> = {}) {
    const record = {
      id: 'p1',
      title: 'Brano di un partner',
      artist: null,
      album: null,
      durationSeconds: null,
      mimeType: 'audio/mpeg',
      size: 2100,
      addedAt: 5,
      hasArtwork: false,
      sourceKey: PARTNER_KEY,
      fileName: 'Brano di un partner',
      artworkBytes: 0,
      source: 'partner-download',
      attribution: null,
      revocabile: true,
      ...overrides,
    };
    db.data.tracks.set('p1', record);
    db.data.files.set('p1', audioWithEmbeddedLyrics('Riga di prova'));
    return record;
  }

  it('non è un file dell’ascoltatore: non si elenca, non si suona, non se ne legge il testo, non si riscrive', async () => {
    const { store, db } = makeStore();
    const record = seedPartnerDownload(db);
    await store.addFiles([audioFile('mio.mp3')]);
    const reader = createLocalMusicReader(db);

    expect((await store.listTracks()).map((track) => track.id)).toEqual(['id-1']);
    expect(await store.getTrack('p1')).toBeNull();
    expect(await reader.getTrack('p1')).toBeNull();
    expect((await store.usage()).tracks).toBe(1);
    // Testo: il file non viene nemmeno aperto.
    db.reads = [];
    expect(await loadLocalLyrics('p1', reader)).toBeNull();
    expect(db.reads).toEqual(['tracks']);
    // Il player che ne salvasse la durata non lo riscrive: il record resta identico sul disco.
    db.trackWrites = [];
    await store.setTrackDuration('p1', 120);
    await reader.setTrackDuration('p1', 120);
    expect(await store.repairFeaturedCopySources()).toBe(0);
    expect(db.trackWrites).toEqual([]);
    expect(rawRecord(db, 'p1')).toEqual(record);
    expect(rawRecord(db, 'p1').source).toBe('partner-download');
  });

  it('nemmeno se una versione precedente l’ha già riscritto come "local": lo dice la chiave', async () => {
    const { store, db } = makeStore();
    seedPartnerDownload(db, { source: 'local', durationSeconds: 99 });
    expect(await store.listTracks()).toEqual([]);
    expect(await store.getTrack('p1')).toBeNull();
    db.reads = [];
    expect(await loadLocalLyrics('p1', createLocalMusicReader(db))).toBeNull();
    expect(db.reads).toEqual(['tracks']);
    expect(await hasDownloadedTrack('featured-download', db)).toBe(false);
  });

  it('«Rimuovi tutti» lo toglie comunque dal dispositivo', async () => {
    const { store, db } = makeStore();
    seedPartnerDownload(db);
    await store.clearAll();
    expect(db.data.tracks.size).toBe(0);
    expect(db.data.files.size).toBe(0);
  });

  it('isUnknownDownloadSourceKey: solo la forma esatta di un download con una fonte sconosciuta', () => {
    expect(isUnknownDownloadSourceKey(PARTNER_KEY)).toBe(true);
    expect(isUnknownDownloadSourceKey(JSON.stringify(['download', '', 'x']))).toBe(true);
    for (const key of [
      // Le fonti che questa versione conosce.
      downloadSourceKey('featured-download', FEATURED_KEY),
      downloadSourceKey('audius-download', 'trk-1'),
      downloadSourceKey('podcast-download', '99~ep-7'),
      // File dell'ascoltatore, qualunque nome abbiano: il secondo elemento è un numero.
      JSON.stringify(['download', 1000, 1]),
      JSON.stringify(['partner-download', 1000, 1]),
      JSON.stringify([PARTNER_KEY, 1000, 1]),
      // Non la forma canonica di un download.
      `["download", "partner-download", "p:123"]`,
      JSON.stringify(['download', 'partner-download', 'p:123', 1]),
      JSON.stringify(['download', 'partner-download']),
      JSON.stringify(['scaricato', 'partner-download', 'p:123']),
      JSON.stringify(['download', 'partner-download', 123]),
      'non json',
      '',
      undefined,
      null,
      42,
    ]) {
      expect(isUnknownDownloadSourceKey(key), String(key)).toBe(false);
    }
  });

  it('un file dell’ascoltatore con un nome che imita quella chiave resta un suo file', async () => {
    const { store } = makeStore();
    const result = await store.addFiles([
      audioFile(PARTNER_KEY, { size: 1001 }),
      audioFile('download', { size: 1002 }),
      audioFile('partner-download', { size: 1003 }),
    ]);
    expect(result.added).toHaveLength(3);
    const tracks = await store.listTracks();
    expect(tracks).toHaveLength(3);
    for (const track of tracks) expect(track.source).toBeUndefined();
  });
});

describe('setTrackDuration riscrive il record com’è sul disco', () => {
  it('i campi che questa versione non conosce sopravvivono alla riscrittura', async () => {
    const { store, db } = makeStore();
    await store.addFiles([audioFile('mio.mp3')]);
    await store.addDownloadedTrack(featuredDownload());
    for (const id of ['id-1', 'id-2']) {
      db.data.tracks.set(id, { ...rawRecord(db, id), campoFuturo: ['a', 1] });
    }
    await store.setTrackDuration('id-1', 240);
    await store.setTrackDuration('id-2', 187);
    expect(rawRecord(db, 'id-1')).toMatchObject({
      source: 'local',
      durationSeconds: 240,
      campoFuturo: ['a', 1],
    });
    expect(rawRecord(db, 'id-2')).toMatchObject({
      source: 'featured-download',
      durationSeconds: 187,
      campoFuturo: ['a', 1],
      attribution,
    });
  });

  it('un file salvato prima che esistesse il campo `source` viene riscritto come "local"', async () => {
    const { store, db } = makeStore();
    await store.addFiles([audioFile('vecchio.mp3')]);
    const { source: _dropped, attribution: _alsoDropped, ...legacy } = rawRecord(db, 'id-1');
    db.data.tracks.set('id-1', legacy);
    await store.setTrackDuration('id-1', 90);
    expect(rawRecord(db, 'id-1')).toMatchObject({ source: 'local', durationSeconds: 90 });
    expect((await store.getTrack('id-1'))?.source).toBeUndefined();
  });
});

describe('un file dell’ascoltatore non diventa mai una copia in evidenza', () => {
  const NAMES = [
    // Il nome comincia con lo stesso prefisso della chiave di una copia (e ha un id valido).
    `featured:${ID_A}`,
    `featured:${ID_A}.mp3`,
    // Il nome è la parola che apre la chiave di ogni download.
    'download',
    // Il nome è l'intera chiave di una copia, così com'è scritta nel record.
    downloadSourceKey('featured-download', FEATURED_KEY),
  ];

  it('un file il cui NOME comincia con "featured:" (o imita la chiave) resta "local"', async () => {
    const { store, db } = makeStore();
    const result = await store.addFiles(
      NAMES.map((name, index) => audioFile(name, { size: 1000 + index })),
    );
    expect(result.added).toHaveLength(NAMES.length);
    expect(result.skipped).toEqual([]);

    const tracks = await store.listTracks();
    expect(tracks).toHaveLength(NAMES.length);
    for (const track of tracks) {
      // La forma storica dei file locali: né fonte, né attribuzione, né chiave di download.
      expect(track.source).toBeUndefined();
      expect(track.attribution).toBeUndefined();
      expect('downloadKey' in track).toBe(false);
      const raw = rawRecord(db, track.id);
      expect(raw.source).toBe('local');
      expect(isFeaturedCopySourceKey(raw.sourceKey)).toBe(false);
      expect(readDownloadSourceKey(raw.sourceKey)).toBeNull();
      // Nemmeno dopo una riscrittura.
      await store.setTrackDuration(track.id, 120);
      expect(rawRecord(db, track.id).source).toBe('local');
      expect((await store.getTrack(track.id))?.source).toBeUndefined();
    }
    expect(await hasDownloadedTrack('featured-download', db)).toBe(false);
  });

  it('la chiave di un file locale ha un numero dove un download ha la fonte', async () => {
    const { store, db } = makeStore();
    await store.addFiles([audioFile(`featured:${ID_A}`, { size: 1234, lastModified: 99 })]);
    expect(rawRecord(db, 'id-1').sourceKey).toBe(JSON.stringify([`featured:${ID_A}`, 1234, 99]));
    // Lo stesso brano scaricato come copia convive con il file: le due chiavi non coincidono.
    expect(await store.addDownloadedTrack(featuredDownload())).toMatchObject({ ok: true });
    const tracks = await store.listTracks();
    expect(tracks.map((track) => track.source ?? 'local').sort()).toEqual([
      'featured-download',
      'local',
    ]);
  });

  it('chiavi quasi giuste non riparano nulla: il record resta "local"', async () => {
    const { store, db } = makeStore();
    await store.addFiles([audioFile('mio.mp3')]);
    const record = rawRecord(db, 'id-1');
    const almost = [
      // Id troppo corto, troppo lungo, con un carattere non ammesso.
      JSON.stringify(['download', 'featured-download', `featured:${ID_A.slice(1)}`]),
      JSON.stringify(['download', 'featured-download', `featured:${ID_A}A`]),
      JSON.stringify(['download', 'featured-download', `featured:${ID_A.slice(1)}/`]),
      // Prefisso diverso, o nessun prefisso.
      JSON.stringify(['download', 'featured-download', `Featured:${ID_A}`]),
      JSON.stringify(['download', 'featured-download', ID_A]),
      // Un'altra fonte con la stessa chiave.
      JSON.stringify(['download', 'audius-download', FEATURED_KEY]),
      // Non la forma esatta: spazi, un elemento in più, un altro primo elemento.
      `["download", "featured-download", "${FEATURED_KEY}"]`,
      JSON.stringify(['download', 'featured-download', FEATURED_KEY, 1]),
      JSON.stringify(['scaricato', 'featured-download', FEATURED_KEY]),
      'non json',
    ];
    for (const sourceKey of almost) {
      db.data.tracks.set('id-1', { ...record, sourceKey });
      expect(isFeaturedCopySourceKey(sourceKey), sourceKey).toBe(false);
      const track = await store.getTrack('id-1');
      expect(track?.source, sourceKey).toBeUndefined();
      expect(track && 'downloadKey' in track, sourceKey).toBe(false);
    }
  });
});

describe('chiave del download (LocalTrack.downloadKey)', () => {
  it('esposta solo per i download, ognuno con la chiave della sua fonte', async () => {
    const { store } = makeStore();
    await store.addDownloadedTrack(
      featuredDownload({ source: 'audius-download', downloadKey: 'trk-1', title: 'Audius' }),
    );
    await store.addDownloadedTrack(
      featuredDownload({ source: 'podcast-download', downloadKey: '99~ep-7', title: 'Podcast' }),
    );
    await store.addDownloadedTrack(featuredDownload({ title: 'In evidenza' }));
    await store.addFiles([audioFile('locale.mp3')]);

    const byTitle = new Map((await store.listTracks()).map((track) => [track.title, track]));
    expect(byTitle.get('Audius')).toMatchObject({
      source: 'audius-download',
      downloadKey: 'trk-1',
    });
    expect(byTitle.get('Podcast')).toMatchObject({
      source: 'podcast-download',
      downloadKey: '99~ep-7',
    });
    expect(byTitle.get('In evidenza')).toMatchObject({
      source: 'featured-download',
      downloadKey: FEATURED_KEY,
    });
    const local = byTitle.get('locale');
    expect(local).toBeDefined();
    expect(local && 'downloadKey' in local).toBe(false);
    expect(local && 'source' in local).toBe(false);
  });

  it('fonte di download ma chiave che non torna: nessuna downloadKey', async () => {
    const { store, db } = makeStore();
    await store.addDownloadedTrack(featuredDownload());
    const record = rawRecord(db, 'id-1');
    for (const sourceKey of [
      // La chiave di un file locale, di un'altra fonte, o rovinata.
      JSON.stringify(['nome.mp3', 1000, 1]),
      JSON.stringify(['download', 'audius-download', 'trk-1']),
      'rovinata',
    ]) {
      db.data.tracks.set('id-1', { ...record, sourceKey });
      const track = await store.getTrack('id-1');
      // Resta una copia (lo dice il campo source), ma senza una chiave da verificare.
      expect(track?.source).toBe('featured-download');
      expect(track && 'downloadKey' in track).toBe(false);
    }
  });

  it('featuredCopyShareId: solo "featured:" + 22 caratteri [A-Za-z0-9_-]', () => {
    expect(featuredCopyShareId(FEATURED_KEY)).toBe(ID_A);
    for (const key of [
      `featured:${ID_A}x`,
      `featured:${ID_A.slice(2)}`,
      `featured:${ID_A.slice(1)}.`,
      ` featured:${ID_A}`,
      ID_A,
      'trk-1',
      '',
      undefined,
      null,
      42,
    ]) {
      expect(featuredCopyShareId(key)).toBeNull();
    }
  });
});

describe('addDownloadedTrack: copia di un brano in evidenza', () => {
  it('si salva solo con la chiave esatta (una copia deve restare verificabile)', async () => {
    const { store, db } = makeStore();
    for (const downloadKey of ['trk-1', `featured:${ID_A}x`, 'featured:', ID_A]) {
      expect(await store.addDownloadedTrack(featuredDownload({ downloadKey }))).toEqual({
        ok: false,
        reason: 'unsupported',
      });
    }
    expect(db.data.tracks.size).toBe(0);
    expect(db.data.files.size).toBe(0);
  });

  it('non si duplica, nemmeno se il record era stato riscritto come "local"', async () => {
    const { store, db } = makeStore();
    expect((await store.addDownloadedTrack(featuredDownload())).ok).toBe(true);
    rewriteLikeTheOldVersion(db, 'id-1');
    expect(await store.addDownloadedTrack(featuredDownload())).toEqual({
      ok: false,
      reason: 'duplicate',
    });
    // Un altro brano in evidenza è un'altra copia.
    expect(
      (await store.addDownloadedTrack(featuredDownload({ downloadKey: `featured:${ID_B}` }))).ok,
    ).toBe(true);
    expect(await store.listTracks()).toHaveLength(2);
  });
});

describe('c’è una copia nella libreria? (per il mount della verifica)', () => {
  it('hasDownloadedTrack: vera con una copia (anche riscritta come "local"), falsa altrimenti', async () => {
    const { store, db } = makeStore();
    expect(await hasDownloadedTrack('featured-download', db)).toBe(false);
    await store.addFiles([audioFile('locale.mp3')]);
    await store.addDownloadedTrack(
      featuredDownload({ source: 'audius-download', downloadKey: 'trk-1' }),
    );
    expect(await hasDownloadedTrack('featured-download', db)).toBe(false);
    expect(await hasDownloadedTrack('audius-download', db)).toBe(true);

    await store.addDownloadedTrack(featuredDownload());
    expect(await hasDownloadedTrack('featured-download', db)).toBe(true);
    rewriteLikeTheOldVersion(db, 'id-3');
    expect(await hasDownloadedTrack('featured-download', db)).toBe(true);
  });

  it('hasDownloadedTrack: una libreria illeggibile è un errore (si riprova), non «nessuna copia»', async () => {
    const db = new MemoryDb();
    db.getAll = async () => {
      throw new Error('idb');
    };
    await expect(hasDownloadedTrack('featured-download', db)).rejects.toThrow('idb');
  });

  it('localMusicDbExists: non crea mai il database', async () => {
    const open = vi.fn();
    const factory = (databases: unknown) => () => ({ open, databases }) as unknown as IDBFactory;
    expect(await localMusicDbExists(factory(async () => [{ name: LOCAL_MUSIC_DB_NAME }]))).toBe(
      true,
    );
    expect(await localMusicDbExists(factory(async () => [{ name: 'altro' }]))).toBe(false);
    // Il browser non sa elencare i database (o l'elenco fallisce): non si può sapere.
    expect(await localMusicDbExists(factory(undefined))).toBeNull();
    expect(
      await localMusicDbExists(
        factory(async () => {
          throw new Error('negato');
        }),
      ),
    ).toBeNull();
    // Senza IndexedDB non c'è nessuna libreria.
    expect(await localMusicDbExists(() => undefined)).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});

describe('testo: mai dai tag del file di una copia in evidenza', () => {
  const EMBEDDED = 'Riga di prova uno\nRiga di prova due';

  it('copia in evidenza (anche riscritta come "local", senza nessun registro): null, file mai aperto', async () => {
    const { store, db } = makeStore();
    await store.addDownloadedTrack(featuredDownload({ blob: audioWithEmbeddedLyrics(EMBEDDED) }));
    const reader = createLocalMusicReader(db);

    db.reads = [];
    expect(await loadLocalLyrics('id-1', reader)).toBeNull();
    expect(db.reads).toEqual(['tracks']);

    // Il caso già successo in produzione: la fonte sul disco è 'local', la chiave è quella esatta.
    rewriteLikeTheOldVersion(db, 'id-1');
    db.reads = [];
    expect(await loadLocalLyrics('id-1', reader)).toBeNull();
    expect(db.reads).toEqual(['tracks']);
  });

  it('lo stesso file aggiunto dall’ascoltatore: il suo testo si legge (è un suo file)', async () => {
    const { store, db } = makeStore();
    const blob = audioWithEmbeddedLyrics(EMBEDDED);
    await store.addFiles([
      new File([blob], `featured:${ID_A}.mp3`, { type: 'audio/mpeg', lastModified: 1 }),
    ]);
    expect(await loadLocalLyrics('id-1', createLocalMusicReader(db))).toEqual({
      kind: 'plain',
      lines: [
        { timeMs: null, text: 'Riga di prova uno' },
        { timeMs: null, text: 'Riga di prova due' },
      ],
      source: 'local',
      credit: 'Dal tuo file',
    });
  });
});

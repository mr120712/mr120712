// @polsia:user-owned — diritti.json, il manifest dei diritti dei brani in evidenza ricercabili:
// validazione (licenze ammesse, niente NC, campi sconosciuti, percorsi non sicuri, non audio,
// upload utenti, doppioni), corrispondenza con i file dello store, lettura dallo store (assente,
// oltre 256 KB, JSON non valido, lento) sempre "nel dubbio si esclude".
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({ get: vi.fn(), list: vi.fn() }));
vi.mock('@vercel/blob', () => ({ get: mocks.get, list: mocks.list }));
vi.mock('@/lib/env', () => ({ env: { BLOB_READ_WRITE_TOKEN: 'tok_test' } }));

import {
  declaredTrackIds,
  parseRightsManifest,
  RIGHTS_MANIFEST_MAX_BYTES,
  readRightsManifest,
} from '@/lib/music/featured-rights.server';

const PRIVATE = 'https://store.private.blob.vercel-storage.com';
const PUBLIC = 'https://store.public.blob.vercel-storage.com';

function entry(file: string, overrides: Record<string, unknown> = {}) {
  return { file, licenza: 'propria', titolare: 'Artista', ...overrides };
}

function manifest(brani: unknown[], extra: Record<string, unknown> = {}) {
  return JSON.stringify({ versione: 1, brani, ...extra });
}

function files(text: string) {
  const parsed = parseRightsManifest(text);
  if (!parsed.ok) throw new Error('manifest non valido');
  return parsed.entries.map((item) => item.file);
}

function manifestFile(size = 200, url = `${PRIVATE}/diritti.json`) {
  return { pathname: 'diritti.json', url, size, uploadedAt: new Date('2026-11-01T00:00:00Z') };
}

function stored(text: string | Uint8Array, headers: Record<string, string> = {}) {
  const body = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  return {
    statusCode: 200,
    stream: new Response(body).body,
    headers: new Headers(headers),
    blob: { pathname: 'diritti.json', contentType: 'application/json', size: body.length },
  };
}

beforeEach(() => {
  mocks.get.mockReset();
  mocks.list.mockReset();
});

describe('parseRightsManifest', () => {
  it('accetta un manifest valido con tutte le licenze ammesse e la prova facoltativa', () => {
    const text = manifest([
      entry('Rock italiano/Artista - Titolo.mp3'),
      entry('Novità/Band - Singolo.flac', {
        licenza: 'licenza',
        titolare: 'Etichetta Srl',
        prova: 'Contratto n. 42',
      }),
      entry('a.mp3', { licenza: 'cc0' }),
      entry('b.mp3', { licenza: 'cc-by', prova: 'https://creativecommons.org/licenses/by/4.0/' }),
      entry('c.ogg', { licenza: 'cc-by-sa' }),
      entry('d.wav', { licenza: 'cc-by-nd' }),
    ]);
    const parsed = parseRightsManifest(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.skipped).toBe(0);
    expect(parsed.entries.map((item) => item.file)).toEqual([
      'Rock italiano/Artista - Titolo.mp3',
      'Novità/Band - Singolo.flac',
      'a.mp3',
      'b.mp3',
      'c.ogg',
      'd.wav',
    ]);
    expect(parsed.entries[1]).toEqual({
      file: 'Novità/Band - Singolo.flac',
      licenza: 'licenza',
      titolare: 'Etichetta Srl',
      prova: 'Contratto n. 42',
    });
  });

  it('rifiuta le licenze NON commerciali (NC) e quelle sconosciute, voce per voce', () => {
    const parsed = parseRightsManifest(
      manifest([
        entry('nc.mp3', { licenza: 'cc-by-nc' }),
        entry('ncsa.mp3', { licenza: 'cc-by-nc-sa' }),
        entry('ncnd.mp3', { licenza: 'cc-by-nc-nd' }),
        entry('maiuscole.mp3', { licenza: 'CC-BY' }),
        entry('boh.mp3', { licenza: 'gratis' }),
        entry('ok.mp3', { licenza: 'cc-by' }),
      ]),
    );
    expect(parsed.ok && parsed.entries.map((item) => item.file)).toEqual(['ok.mp3']);
    expect(parsed.ok && parsed.skipped).toBe(5);
  });

  it('un campo sconosciuto scarta la voce; al primo livello annulla tutto il manifest', () => {
    expect(files(manifest([entry('a.mp3', { note: 'x' }), entry('b.mp3')]))).toEqual(['b.mp3']);
    expect(parseRightsManifest(manifest([entry('b.mp3')], { extra: true }))).toEqual({ ok: false });
  });

  it('titolare obbligatorio (1-120 caratteri) e prova al massimo 300 caratteri', () => {
    expect(
      files(
        manifest([
          entry('vuoto.mp3', { titolare: '   ' }),
          entry('lungo.mp3', { titolare: 'x'.repeat(121) }),
          { file: 'senza.mp3', licenza: 'propria' },
          entry('prova.mp3', { prova: 'p'.repeat(301) }),
          entry('ok.mp3', { titolare: 'x'.repeat(120), prova: 'p'.repeat(300) }),
        ]),
      ),
    ).toEqual(['ok.mp3']);
  });

  it('rifiuta percorsi che risalgono, assoluti, URL, upload degli utenti e file non audio', () => {
    const parsed = parseRightsManifest(
      manifest([
        entry('../segreto.mp3'),
        entry('Rock/../public-uploads/x.mp3'),
        entry('/assoluto.mp3'),
        entry('./qui.mp3'),
        entry('Rock\\\\finestra.mp3'),
        entry('https://store.public.blob.vercel-storage.com/a.mp3'),
        entry('public-uploads/di-un-utente.mp3'),
        entry('copertina.jpg'),
        entry('diritti.json'),
        entry('senza-estensione'),
        entry('Rock//doppia.mp3'),
        entry('ok.mp3'),
      ]),
    );
    expect(parsed.ok && parsed.entries.map((item) => item.file)).toEqual(['ok.mp3']);
    expect(parsed.ok && parsed.skipped).toBe(11);
  });

  it('i doppioni collassano in una voce sola', () => {
    expect(
      files(manifest([entry('a.mp3'), entry('a.mp3', { licenza: 'cc0' }), entry('b.mp3')])),
    ).toEqual(['a.mp3', 'b.mp3']);
  });

  it('JSON non valido, versione diversa da 1 o forma sbagliata → nessun brano', () => {
    expect(parseRightsManifest('{ "versione": 1, "brani": [ ')).toEqual({ ok: false });
    expect(parseRightsManifest(manifest([entry('a.mp3')], { versione: 2 }))).toEqual({
      ok: false,
    });
    expect(parseRightsManifest(JSON.stringify({ versione: 1 }))).toEqual({ ok: false });
    expect(parseRightsManifest(JSON.stringify({ versione: 1, brani: {} }))).toEqual({ ok: false });
    expect(parseRightsManifest(JSON.stringify([entry('a.mp3')]))).toEqual({ ok: false });
    expect(parseRightsManifest('')).toEqual({ ok: false });
  });

  it('accetta il BOM UTF-8 iniziale (Blocco note di Windows)', () => {
    expect(files(`﻿${manifest([entry('a.mp3')])}`)).toEqual(['a.mp3']);
  });
});

describe('declaredTrackIds', () => {
  it('solo i file esistenti nello store, con corrispondenza esatta', () => {
    const parsed = parseRightsManifest(
      manifest([entry('Rock/A - B.mp3'), entry('rock/a - b.mp3'), entry('Non esiste.mp3')]),
    );
    if (!parsed.ok) throw new Error('manifest non valido');
    const declared = declaredTrackIds(parsed.entries, ['Rock/A - B.mp3', 'Altro.mp3']);
    // Maiuscole diverse = file diverso; un file inesistente non rende ricercabile nulla.
    expect([...declared]).toEqual(['Rock/A - B.mp3']);
  });

  it('un nome accentato scomposto (NFD, da Mac) corrisponde alla forma composta del manifest', () => {
    const nfd = 'Novità/Città.mp3'.normalize('NFD');
    const parsed = parseRightsManifest(manifest([entry('Novità/Città.mp3')]));
    if (!parsed.ok) throw new Error('manifest non valido');
    expect([...declaredTrackIds(parsed.entries, [nfd])]).toEqual([nfd]);
    // Due file con la stessa forma NFC: serve il nome esatto.
    const nfc = 'Novità/Città.mp3';
    expect([...declaredTrackIds(parsed.entries, [nfd, nfc])]).toEqual([nfc]);
    const onlyNfd = parseRightsManifest(manifest([entry('Novità/Città.mp3'.normalize('NFD'))]));
    if (!onlyNfd.ok) throw new Error('manifest non valido');
    expect([...declaredTrackIds(onlyNfd.entries, [nfd, nfc])]).toEqual([nfd]);
  });
});

describe('readRightsManifest', () => {
  it('legge il manifest privato con il token, dall’origine, entro la scadenza', async () => {
    mocks.get.mockResolvedValue(stored(manifest([entry('a.mp3')])));
    const result = await readRightsManifest('tok_test', manifestFile());
    expect(result).toEqual({
      status: 'ok',
      entries: [{ file: 'a.mp3', licenza: 'propria', titolare: 'Artista' }],
      skipped: 0,
    });
    expect(mocks.get).toHaveBeenCalledWith(
      'diritti.json',
      expect.objectContaining({ access: 'private', token: 'tok_test', useCache: false }),
    );
  });

  it('un manifest reso pubblico si legge con accesso pubblico', async () => {
    mocks.get.mockResolvedValue(stored(manifest([entry('a.mp3')])));
    await readRightsManifest('tok_test', manifestFile(200, `${PUBLIC}/diritti.json`));
    expect(mocks.get.mock.calls[0]?.[1]).toMatchObject({ access: 'public' });
  });

  it('manifest assente (non caricato o 404 dello store) → missing', async () => {
    expect(await readRightsManifest('tok_test', null)).toEqual({ status: 'missing' });
    expect(mocks.get).not.toHaveBeenCalled();
    mocks.get.mockResolvedValue(null);
    expect(await readRightsManifest('tok_test', manifestFile())).toEqual({ status: 'missing' });
  });

  it('oltre 256 KB → oversize, senza scaricarlo se l’elenco lo dice già', async () => {
    expect(
      await readRightsManifest('tok_test', manifestFile(RIGHTS_MANIFEST_MAX_BYTES + 1)),
    ).toEqual({ status: 'oversize' });
    expect(mocks.get).not.toHaveBeenCalled();

    // Dimensione dichiarata dallo storage oltre il limite.
    mocks.get.mockResolvedValueOnce(
      stored(manifest([]), { 'content-length': String(RIGHTS_MANIFEST_MAX_BYTES + 10) }),
    );
    expect(await readRightsManifest('tok_test', manifestFile())).toEqual({ status: 'oversize' });

    // Byte reali oltre il limite (l'elenco era vecchio): letti al massimo 256 KB + 1.
    const big = `${manifest([entry('a.mp3')]).slice(0, -1)}${' '.repeat(RIGHTS_MANIFEST_MAX_BYTES)}}`;
    mocks.get.mockResolvedValueOnce(stored(big));
    expect(await readRightsManifest('tok_test', manifestFile())).toEqual({ status: 'oversize' });
  });

  it('JSON non valido o UTF-8 non valido → invalid', async () => {
    mocks.get.mockResolvedValueOnce(stored('{ non è json'));
    expect(await readRightsManifest('tok_test', manifestFile())).toEqual({ status: 'invalid' });
    mocks.get.mockResolvedValueOnce(stored(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])));
    expect(await readRightsManifest('tok_test', manifestFile())).toEqual({ status: 'invalid' });
  });

  it('errore dello store → unavailable, senza throw', async () => {
    mocks.get.mockRejectedValue(new Error('rete'));
    expect(await readRightsManifest('tok_test', manifestFile())).toEqual({
      status: 'unavailable',
    });
  });

  it('store che non risponde → unavailable entro la scadenza', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mocks.get.mockReturnValue(new Promise(() => undefined));
      const pending = readRightsManifest('tok_test', manifestFile(), 1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await pending).toEqual({ status: 'unavailable' });
    } finally {
      vi.useRealTimers();
    }
  });
});

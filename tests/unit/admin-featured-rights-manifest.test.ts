// @polsia:user-owned — diagnosi di diritti.json per la pagina admin «Diritti e testi»: ogni regola
// del parser ha il suo motivo in italiano (licenze NC o sconosciute, campi in più, titolare,
// percorsi, non audio, "testo" non booleano, doppioni, file non trovati), errori del manifest con
// riga e colonna, e soprattutto le STESSE decisioni del parser vero (parseRightsManifest +
// declaredTrackEntries): la diagnosi spiega, non decide.
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));
vi.mock('@vercel/blob', () => ({ list: mocks.list, get: mocks.get }));
vi.mock('@/lib/env', () => ({ env: { BLOB_READ_WRITE_TOKEN: 'tok_test' } }));

import {
  declaredTrackEntries,
  diagnoseRightsManifest,
  diagnoseRightsManifestText,
  parseRightsManifest,
  RIGHTS_MANIFEST_MAX_BYTES,
  type RightsManifestDiagnosis,
  readRightsManifest,
} from '@/lib/music/featured-rights.server';

const ROCK = 'Rock/Artista - Titolo.mp3';
const SONG = 'Cantautori/Autrice - Canzone.mp3';
const ACCENTED = 'Cantautori/Autrice - Città.mp3';
const STORE = [ROCK, SONG, ACCENTED, 'Strumentale - Pioggia.flac'];
const OK = { file: ROCK, licenza: 'propria', titolare: 'Artista' };

function manifestText(brani: unknown[], extra: Record<string, unknown> = {}) {
  return JSON.stringify({ versione: 1, brani, ...extra }, null, 2);
}

function diagnose(brani: unknown[], store: readonly string[] = STORE) {
  return diagnoseRightsManifestText(manifestText(brani), store);
}

/** I motivi della voce `entry` (da sola dopo una voce valida, così l'indice è sempre 2). */
function reasonsFor(entry: unknown): string[] {
  const result = diagnose([{ ...OK, file: SONG }, entry]);
  expect(result.status).toBe('valid');
  const problem = result.problems.find((item) => item.index === 2);
  expect(problem, JSON.stringify(entry)).toBeDefined();
  return problem?.reasons ?? [];
}

function expectConsistent(result: RightsManifestDiagnosis) {
  const { entries, valid, invalid, ignored } = result.counts;
  expect(valid + invalid + ignored).toBe(entries);
  expect(result.problems).toHaveLength(invalid + ignored);
  expect(result.declared.size).toBe(valid);
  for (const problem of result.problems) expect(problem.reasons.length).toBeGreaterThan(0);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('diagnoseRightsManifestText: voci valide', () => {
  it('manifest valido: nessun problema, conteggi e voci dichiarate come la ricerca', () => {
    const result = diagnose([
      { ...OK, testo: true },
      { file: SONG, licenza: 'licenza', titolare: 'Etichetta Srl', prova: 'Contratto n. 42' },
      { file: 'Strumentale - Pioggia.flac', licenza: 'cc-by', titolare: 'Strumentale' },
    ]);
    expect(result.status).toBe('valid');
    expect(result.reasons).toEqual([]);
    expect(result.location).toBeNull();
    expect(result.counts).toEqual({ entries: 3, valid: 3, invalid: 0, ignored: 0 });
    expect(result.problems).toEqual([]);
    expect([...result.declared.keys()]).toEqual([ROCK, SONG, 'Strumentale - Pioggia.flac']);
    expect(result.declared.get(ROCK)).toEqual({ ...OK, testo: true });
    expectConsistent(result);
  });

  it('accetta il BOM UTF-8 iniziale, come il parser', () => {
    const result = diagnoseRightsManifestText(`﻿${manifestText([OK])}`, STORE);
    expect(result.status).toBe('valid');
    expect(result.counts.valid).toBe(1);
  });
});

describe('diagnoseRightsManifestText: un motivo per ogni regola delle voci', () => {
  it('licenze non commerciali, sconosciute, scritte in modo diverso o mancanti', () => {
    expect(reasonsFor({ ...OK, licenza: 'cc-by-nc' })).toEqual([
      'licenza non accettata: cc-by-nc (uso non commerciale)',
    ]);
    expect(reasonsFor({ ...OK, licenza: 'cc-by-nc-sa' })).toEqual([
      'licenza non accettata: cc-by-nc-sa (uso non commerciale)',
    ]);
    expect(reasonsFor({ ...OK, licenza: 'cc-by-nc-nd' })[0]).toContain('uso non commerciale');
    expect(reasonsFor({ ...OK, licenza: 'gratis' })[0]).toMatch(
      /^licenza sconosciuta: gratis \(ammesse: propria, licenza, cc0, cc-by, cc-by-sa, cc-by-nd\)$/,
    );
    expect(reasonsFor({ ...OK, licenza: 'CC-BY' })).toEqual([
      'licenza scritta in modo diverso: usa esattamente "cc-by" (minuscole, senza spazi)',
    ]);
    const { licenza: _licenza, ...withoutLicence } = OK;
    expect(reasonsFor(withoutLicence)).toEqual(['licenza mancante']);
    expect(reasonsFor({ ...OK, licenza: 3 })[0]).toContain('"licenza" deve essere un testo');
  });

  it('campi sconosciuti: uno per motivo, al massimo 8 motivi per voce', () => {
    expect(reasonsFor({ ...OK, x: 1 })).toEqual(['campo sconosciuto: x']);
    expect(reasonsFor({ ...OK, Testo: true, anno: 2026 })).toEqual([
      'campo sconosciuto: Testo',
      'campo sconosciuto: anno',
    ]);
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`extra${i}`, i]));
    const reasons = reasonsFor({ ...OK, ...many });
    expect(reasons).toHaveLength(8);
    expect(reasons.at(-1)).toBe('… e altri 13 problemi');
  });

  it('titolare mancante, vuoto, solo spazi o troppo lungo', () => {
    const { titolare: _titolare, ...withoutHolder } = OK;
    for (const entry of [
      withoutHolder,
      { ...OK, titolare: '' },
      { ...OK, titolare: '   ' },
      { ...OK, titolare: 'x'.repeat(121) },
      { ...OK, titolare: 7 },
    ]) {
      expect(reasonsFor(entry)).toEqual([
        'titolare mancante o troppo lungo (da 1 a 120 caratteri)',
      ]);
    }
  });

  it('prova troppo lunga e "testo" non booleano', () => {
    expect(reasonsFor({ ...OK, prova: 'p'.repeat(301) })).toEqual([
      '"prova" troppo lunga (al massimo 300 caratteri)',
    ]);
    expect(reasonsFor({ ...OK, testo: 'si' })).toEqual([
      '"testo" deve essere true o false (senza virgolette)',
    ]);
    expect(reasonsFor({ ...OK, testo: 'true' })[0]).toContain('"testo" deve essere true o false');
  });

  it('percorsi non validi, upload degli utenti e file non audio', () => {
    expect(reasonsFor({ ...OK, file: '../Rock/x.mp3' })).toEqual([
      'percorso non valido (..): niente cartelle "." o ".."',
    ]);
    expect(reasonsFor({ ...OK, file: 'Rock/../public-uploads/u/a.mp3' })[0]).toContain(
      'percorso non valido (..)',
    );
    expect(reasonsFor({ ...OK, file: `/${ROCK}` })).toEqual([
      'percorso non valido: togli la "/" iniziale',
    ]);
    expect(reasonsFor({ ...OK, file: 'https://example.com/brano.mp3' })[0]).toContain(
      'non un indirizzo web',
    );
    expect(reasonsFor({ ...OK, file: 'Rock\\Artista - Titolo.mp3' })[0]).toContain(
      'percorso non valido',
    );
    expect(reasonsFor({ ...OK, file: 'Rock//Titolo.mp3' })[0]).toContain('cartella vuota');
    expect(reasonsFor({ ...OK, file: 'Rock/Tito\u0007lo.mp3' })[0]).toContain(
      'caratteri di controllo',
    );
    expect(reasonsFor({ ...OK, file: 'public-uploads/u1/brano.mp3' })[0]).toContain(
      'public-uploads/',
    );
    for (const file of ['Rock/cover.jpg', 'Rock/Artista - Titolo.lrc', 'Rock/Artista - Titolo']) {
      expect(reasonsFor({ ...OK, file })[0]).toMatch(/^non è un file audio/);
    }
  });

  it('"file" mancante, vuoto, non testo o troppo lungo; voce che non è un oggetto', () => {
    const { file: _file, ...withoutFile } = OK;
    expect(reasonsFor(withoutFile)).toEqual(['"file" mancante']);
    expect(reasonsFor({ ...OK, file: '' })).toEqual(['"file" vuoto']);
    expect(reasonsFor({ ...OK, file: 42 })[0]).toContain('"file" deve essere un testo');
    expect(reasonsFor({ ...OK, file: `${'a/'.repeat(520)}x.mp3` })[0]).toContain(
      '"file" troppo lungo',
    );
    for (const row of ['Rock/Artista - Titolo.mp3', null, 3, [OK]]) {
      expect(reasonsFor(row)).toEqual([
        'la voce non è un oggetto: { "file": …, "licenza": …, "titolare": … }',
      ]);
    }
  });

  it('più problemi nella stessa voce: tutti, senza ripetizioni', () => {
    const reasons = reasonsFor({ file: SONG, licenza: 'cc-by-nc', titolare: '', testo: 1, z: 0 });
    expect(reasons).toEqual([
      // Stesso file della voce valida n. 1: nel dubbio testo e copia offline restano spenti.
      'nomina lo stesso file della voce n. 1: finché non la correggi o la togli, testo e copia offline di quel file restano spenti (nel dubbio si esclude)',
      'licenza non accettata: cc-by-nc (uso non commerciale)',
      'titolare mancante o troppo lungo (da 1 a 120 caratteri)',
      '"testo" deve essere true o false (senza virgolette)',
      'campo sconosciuto: z',
    ]);
  });

  it('riporta "file" come è scritto, troncato a 300 caratteri; null se non è un testo', () => {
    const long = `Rock/${'L'.repeat(400)}.mp3`;
    const result = diagnose([
      { ...OK, file: long, licenza: 'cc-by-nc' },
      { ...OK, file: 5 },
    ]);
    const [first, second] = result.problems;
    expect(first?.file).toBe(`${long.slice(0, 300)}…`);
    expect(first?.kind).toBe('invalid');
    expect(second?.file).toBeNull();
  });
});

describe('diagnoseRightsManifestText: voci valide ma senza effetto', () => {
  it('file non trovato nello store (anche con maiuscole diverse) → ignorata', () => {
    const result = diagnose([
      OK,
      { ...OK, file: 'Rock/Inesistente.mp3' },
      { ...OK, file: 'rock/artista - titolo.mp3' },
    ]);
    expect(result.counts).toEqual({ entries: 3, valid: 1, invalid: 0, ignored: 2 });
    expect(result.problems).toEqual([
      {
        index: 2,
        file: 'Rock/Inesistente.mp3',
        kind: 'ignored',
        reasons: [
          'file non trovato nello store: controlla cartelle, maiuscole, spazi ed estensione',
        ],
      },
      {
        index: 3,
        file: 'rock/artista - titolo.mp3',
        kind: 'ignored',
        reasons: [
          'file non trovato nello store: c’è un file con lo stesso nome ma maiuscole/minuscole diverse (il percorso deve essere identico)',
        ],
      },
    ]);
    expectConsistent(result);
  });

  it('con un elenco incompleto "non trovato" lo dice', () => {
    const result = diagnoseRightsManifestText(
      manifestText([{ ...OK, file: 'Rock/Nuovo.mp3' }]),
      STORE,
      false,
    );
    expect(result.problems[0]?.reasons).toEqual([
      'file non trovato nello store (elenco dello store incompleto: riprova tra poco)',
    ]);
  });

  it('nome accentato scomposto (NFD, da Mac) = stesso brano della voce composta', () => {
    const nfd = ACCENTED.normalize('NFD');
    const result = diagnose([{ ...OK, file: ACCENTED }], [nfd]);
    expect([...result.declared.keys()]).toEqual([nfd]);
    expect(result.problems).toEqual([]);
  });

  it('due file diversi con la stessa forma NFC e nessuna corrispondenza esatta → ambiguo', () => {
    // "Å" come segno dell'ångström (U+212B) e come A + anello combinante: due file distinti che
    // in forma NFC diventano entrambi "Å" (U+00C5), la forma scritta nella voce.
    const angstromSign = 'Pop/\u212Bngstrom.mp3';
    const decomposed = 'Pop/A\u030Angstrom.mp3';
    const written = 'Pop/\u00C5ngstrom.mp3';
    expect(angstromSign.normalize('NFC')).toBe(written);
    expect(decomposed.normalize('NFC')).toBe(written);
    const result = diagnose([{ ...OK, file: written }], [angstromSign, decomposed]);
    expect(result.declared.size).toBe(0);
    expect(result.problems).toEqual([
      {
        index: 1,
        file: written,
        kind: 'ignored',
        reasons: [
          'più file nello store hanno questo nome scritto con accenti in forme diverse: scrivi il percorso esatto',
        ],
      },
    ]);
    // Con il percorso esatto di uno dei due, vale.
    const exact = diagnose([{ ...OK, file: decomposed }], [angstromSign, decomposed]);
    expect([...exact.declared.keys()]).toEqual([decomposed]);
  });

  it('voce duplicata: vale la prima; disaccordo su "testo" → testo spento e spiegato', () => {
    const result = diagnose([
      { ...OK, testo: true },
      { ...OK, titolare: 'Altro' },
      { ...OK, file: SONG },
      { ...OK, file: SONG },
    ]);
    expect(result.counts).toEqual({ entries: 4, valid: 2, invalid: 0, ignored: 2 });
    expect(result.declared.get(ROCK)).toEqual({ ...OK, testo: false });
    expect(result.problems).toEqual([
      {
        index: 2,
        file: ROCK,
        kind: 'ignored',
        reasons: [
          'voce duplicata (vale la prima): stesso file della voce n. 1',
          'le voci dello stesso file non sono d’accordo su "testo": il testo resta spento (serve "testo": true in tutte)',
        ],
      },
      {
        index: 4,
        file: SONG,
        kind: 'ignored',
        reasons: ['voce duplicata (vale la prima): stesso file della voce n. 3'],
      },
    ]);
    expectConsistent(result);
  });

  it('doppione con un nome Unicode diverso dello stesso file', () => {
    const result = diagnose([
      { ...OK, file: ACCENTED, testo: true },
      { ...OK, file: ACCENTED.normalize('NFD'), testo: true },
    ]);
    expect(result.problems).toEqual([
      {
        index: 2,
        file: ACCENTED.normalize('NFD'),
        kind: 'ignored',
        reasons: ['voce duplicata (vale la prima): stesso file della voce n. 1'],
      },
    ]);
    expect(result.declared.get(ACCENTED)?.testo).toBe(true);
  });
});

describe('diagnoseRightsManifestText: il manifest intero non vale', () => {
  it('JSON non valido con riga e colonna', () => {
    const text = '{\n  "versione": 1,\n  brani: []\n}';
    const result = diagnoseRightsManifestText(text, STORE);
    expect(result.status).toBe('invalid');
    expect(result.location).toEqual({ line: 3, column: 3 });
    expect(result.reasons).toEqual([
      'JSON non valido alla riga 3, colonna 3: controlla virgole, virgolette e parentesi',
    ]);
    expect(result.counts).toEqual({ entries: 0, valid: 0, invalid: 0, ignored: 0 });
    expect(result.problems).toEqual([]);
    expect(result.declared.size).toBe(0);
  });

  it('virgola in più in fondo a un elenco: riga e colonna giuste', () => {
    const text = manifestText([OK]).replace('"Artista"\n', '"Artista",\n');
    const result = diagnoseRightsManifestText(text, STORE);
    expect(result.status).toBe('invalid');
    const line = text.split('\n').findIndex((row) => row.trim() === '}') + 1;
    expect(result.location?.line).toBe(line);
  });

  it('file troncato o vuoto: finisce prima del previsto', () => {
    for (const text of ['{ "versione": 1, "brani": [', '']) {
      const result = diagnoseRightsManifestText(text, STORE);
      expect(result.status).toBe('invalid');
      expect(result.reasons[0]).toContain('finisce prima del previsto');
    }
  });

  it('versione, campi al primo livello, "brani" non elenco, radice non oggetto, troppe voci', () => {
    const cases: Array<[string, string]> = [
      [JSON.stringify({ versione: 2, brani: [] }), '"versione" sbagliata'],
      [JSON.stringify({ versione: '1', brani: [] }), '"versione" sbagliata'],
      [JSON.stringify({ brani: [] }), 'manca "versione": 1'],
      [JSON.stringify({ versione: 1 }), 'manca "brani"'],
      [JSON.stringify({ versione: 1, brani: {} }), '"brani" non è un elenco'],
      [JSON.stringify({ versione: 1, brani: 'tutti' }), '"brani" non è un elenco'],
      [
        JSON.stringify({ versione: 1, brani: [], note: 'x' }),
        'campo sconosciuto al primo livello: note',
      ],
      [JSON.stringify([OK]), 'il manifest deve essere un oggetto JSON'],
      ['null', 'il manifest deve essere un oggetto JSON'],
      [
        JSON.stringify({ versione: 1, brani: Array.from({ length: 5001 }, () => OK) }),
        'più di 5000 voci',
      ],
    ];
    for (const [text, expected] of cases) {
      const result = diagnoseRightsManifestText(text, STORE);
      expect(result.status, text.slice(0, 60)).toBe('invalid');
      expect(result.reasons.join(' | '), text.slice(0, 60)).toContain(expected);
      expect(result.declared.size).toBe(0);
    }
  });
});

describe('stesse decisioni del parser vero (nessun secondo validatore)', () => {
  const fixtures: string[] = [
    manifestText([OK, { ...OK, file: SONG, testo: true }]),
    manifestText([{ ...OK, licenza: 'cc-by-nc' }, OK, { ...OK, x: 1 }]),
    manifestText([
      { ...OK, testo: true },
      { ...OK, testo: false },
      { ...OK, file: SONG },
    ]),
    manifestText([
      { ...OK, file: ACCENTED.normalize('NFD') },
      { ...OK, file: ACCENTED },
    ]),
    manifestText([
      { ...OK, file: 'Rock/Assente.mp3' },
      { ...OK, file: '../x.mp3' },
    ]),
    manifestText([
      { ...OK, file: 'public-uploads/a.mp3' },
      { ...OK, testo: 'si' },
    ]),
    manifestText([]),
    `﻿${manifestText([OK])}`,
    '{ non json',
    JSON.stringify({ versione: 2, brani: [OK] }),
    JSON.stringify({ versione: 1, brani: [OK], extra: true }),
  ];

  it('valido ⇔ parseRightsManifest ok; brani dichiarati identici a declaredTrackEntries', () => {
    const stores = [STORE, [ACCENTED.normalize('NFD'), ROCK], []];
    for (const text of fixtures) {
      const parsed = parseRightsManifest(text);
      for (const store of stores) {
        const result = diagnoseRightsManifestText(text, store);
        expect(result.status === 'valid', text.slice(0, 80)).toBe(parsed.ok);
        const expected = parsed.ok ? declaredTrackEntries(parsed.entries, store) : new Map();
        expect([...result.declared.entries()]).toEqual([...expected.entries()]);
        if (parsed.ok) {
          expect(result.counts.invalid).toBe(parsed.skipped);
          expectConsistent(result);
        }
      }
    }
  });
});

describe('diagnoseRightsManifest: lettura dallo store come la ricerca', () => {
  const PRIVATE = 'https://store.private.blob.vercel-storage.com';
  const manifestFile = (size: number) => ({
    pathname: 'diritti.json',
    url: `${PRIVATE}/diritti.json`,
    size,
    uploadedAt: new Date('2026-11-01T00:00:00Z'),
  });

  function respondWith(bytes: Uint8Array, contentLength = bytes.length) {
    mocks.get.mockResolvedValue({
      statusCode: 200,
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      headers: new Headers({ 'content-length': String(contentLength) }),
    });
  }

  it('valido: legge il manifest privato dall’origine con il token, come readRightsManifest', async () => {
    const bytes = new TextEncoder().encode(manifestText([OK, { ...OK, x: 1 }]));
    respondWith(bytes);
    const result = await diagnoseRightsManifest('tok_test', manifestFile(bytes.length), STORE);
    expect(result.status).toBe('valid');
    expect(result.counts).toEqual({ entries: 2, valid: 1, invalid: 1, ignored: 0 });
    expect(mocks.get).toHaveBeenCalledWith(
      'diritti.json',
      expect.objectContaining({ access: 'private', token: 'tok_test', useCache: false }),
    );
    respondWith(bytes);
    const real = await readRightsManifest('tok_test', manifestFile(bytes.length));
    expect(real.status).toBe('ok');
  });

  it('assente → missing; assente con elenco incompleto → unavailable (non si sa)', async () => {
    expect((await diagnoseRightsManifest('tok_test', null, STORE)).status).toBe('missing');
    const partial = await diagnoseRightsManifest('tok_test', null, STORE, {
      listingComplete: false,
    });
    expect(partial.status).toBe('unavailable');
    expect(partial.reasons[0]).toContain('elenco dello store incompleto');
    mocks.get.mockResolvedValue(null);
    expect((await diagnoseRightsManifest('tok_test', manifestFile(10), STORE)).status).toBe(
      'missing',
    );
  });

  it('oltre 256 KB (dall’elenco, senza scaricarlo, o dal content-length) → invalid', async () => {
    const big = await diagnoseRightsManifest(
      'tok_test',
      manifestFile(RIGHTS_MANIFEST_MAX_BYTES + 1),
      STORE,
    );
    expect(big.status).toBe('invalid');
    expect(big.reasons).toEqual([
      'diritti.json supera 256 KB: nessun brano è ricercabile finché non lo riduci',
    ]);
    expect(mocks.get).not.toHaveBeenCalled();

    respondWith(new Uint8Array(4), RIGHTS_MANIFEST_MAX_BYTES + 1);
    const declaredBig = await diagnoseRightsManifest('tok_test', manifestFile(100), STORE);
    expect(declaredBig.reasons[0]).toContain('supera 256 KB');
  });

  it('UTF-8 non valido → invalid con il motivo; errore dello store → unavailable', async () => {
    respondWith(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]));
    const utf8 = await diagnoseRightsManifest('tok_test', manifestFile(4), STORE);
    expect(utf8.status).toBe('invalid');
    expect(utf8.reasons).toEqual([
      'diritti.json non è testo UTF-8 valido: salvalo con la codifica UTF-8',
    ]);

    mocks.get.mockRejectedValue(new Error('rete'));
    const down = await diagnoseRightsManifest('tok_test', manifestFile(4), STORE);
    expect(down.status).toBe('unavailable');
    expect(down.reasons[0]).toContain('non riesco a leggere diritti.json');
  });

  it('store che non risponde → unavailable entro la scadenza', async () => {
    mocks.get.mockImplementation(() => new Promise(() => undefined));
    const started = Date.now();
    const result = await diagnoseRightsManifest('tok_test', manifestFile(4), STORE, {
      deadlineMs: 30,
    });
    expect(result.status).toBe('unavailable');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('diagnosi: spiegazioni più precise (stesse decisioni del parser)', () => {
  it('virgolette tipografiche, semplici e True: riga, colonna e consiglio specifico', () => {
    const cases: Array<[string, { line: number; column: number }, string]> = [
      [
        '{\n  "versione": 1,\n  "brani": [ { “file”: "a.mp3" } ]\n}',
        { line: 3, column: 16 },
        'JSON non valido alla riga 3, colonna 16: virgolette tipografiche (“ ” ‘ ’): usa le virgolette dritte " (scrivi il file con un editor di testo, non con le note del telefono)',
      ],
      [
        '{\n  "versione": 1,\n  "brani": [ { "file": “a.mp3” } ]\n}',
        { line: 3, column: 24 },
        'JSON non valido alla riga 3, colonna 24: virgolette tipografiche (“ ” ‘ ’): usa le virgolette dritte " (scrivi il file con un editor di testo, non con le note del telefono)',
      ],
      [
        '{\n  \'versione\': 1,\n  "brani": []\n}',
        { line: 2, column: 3 },
        'JSON non valido alla riga 2, colonna 3: virgolette semplici \': in JSON testi e nomi vanno fra virgolette doppie "',
      ],
      [
        '{\n  "versione": 1,\n  "brani": [\n    { "file": "a.mp3", "testo": True }\n  ]\n}',
        { line: 4, column: 33 },
        'JSON non valido alla riga 4, colonna 33: true, false e null vanno scritti in minuscolo e senza virgolette',
      ],
    ];
    for (const [text, location, reason] of cases) {
      const result = diagnoseRightsManifestText(text, STORE);
      expect(result.status, text).toBe('invalid');
      expect(result.location, text).toEqual(location);
      expect(result.reasons, text).toEqual([reason]);
      // Il parser vero lo rifiuta comunque: la diagnosi spiega soltanto.
      expect(parseRightsManifest(text).ok).toBe(false);
    }
  });

  it('virgolette tipografiche DENTRO un testo valido non confondono la posizione', () => {
    const text = '{\n  "versione": 1,\n  "brani": [ { "titolare": "Il “Gruppo”", “file”: 1 } ]\n}';
    const result = diagnoseRightsManifestText(text, STORE);
    const column = (text.split('\n')[2] ?? '').indexOf('“file”') + 1;
    expect(result.location).toEqual({ line: 3, column });
  });

  it('errore dello schema E percorso non ammesso: entrambi i motivi subito', () => {
    expect(reasonsFor({ file: '/Rock/A - B.jpg', licenza: 'cc-by-nc', titolare: 'x' })).toEqual([
      'licenza non accettata: cc-by-nc (uso non commerciale)',
      'percorso non valido: togli la "/" iniziale',
    ]);
    expect(reasonsFor({ file: 'Rock/copertina.jpg', licenza: 'propria', titolare: '' })).toEqual([
      'titolare mancante o troppo lungo (da 1 a 120 caratteri)',
      'non è un file audio (serve un’estensione audio: .mp3, .m4a, .flac, .wav, .ogg…)',
    ]);
    // "file" non testo: nessun motivo di percorso inventato.
    expect(reasonsFor({ file: 5, licenza: 'propria', titolare: 'x' })).toEqual([
      '"file" deve essere un testo: il percorso del brano nello store',
    ]);
  });

  it('testo spento dal disaccordo fra doppioni: la voce che lo spegne, in entrambi gli ordini', () => {
    const result = diagnose([
      { ...OK, testo: true },
      { ...OK, testo: true },
      { ...OK },
      { ...OK, file: SONG },
      { ...OK, file: SONG, testo: true },
      { ...OK, file: ACCENTED, testo: true },
      { ...OK, file: ACCENTED, testo: true },
    ]);
    expect(result.declared.get(ROCK)?.testo).toBe(false);
    expect(result.declared.get(SONG)?.testo).toBeUndefined();
    expect(result.declared.get(ACCENTED)?.testo).toBe(true);
    expect([...result.lyricsOffBy.entries()]).toEqual([
      [ROCK, 3],
      [SONG, 4],
    ]);
    // Senza doppioni (o senza nessun "testo": true) non c'è disaccordo da spiegare.
    expect(diagnose([OK, { ...OK, file: SONG, testo: false }]).lyricsOffBy.size).toBe(0);
  });
});

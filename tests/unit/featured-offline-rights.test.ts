// @polsia:user-owned — copia offline dei brani in evidenza: il campo "offline" di diritti.json
// (tipi, voci non valide, doppioni conservativi in qualunque ordine), la regola per ogni licenza ×
// "offline" (featuredOfflinePermission / offlineEligibility, lato server e lato client) e la
// diagnosi dell'amministratore (copia spenta da un doppione, motivo per un valore sbagliato).
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@vercel/blob', () => ({ get: vi.fn(), list: vi.fn() }));
vi.mock('@/lib/env', () => ({ env: { BLOB_READ_WRITE_TOKEN: 'tok_test' } }));

import {
  diagnoseRightsManifestText,
  offlineBasis,
  offlineDeclared,
  parseRightsManifest,
  RIGHTS_LICENSES,
} from '@/lib/music/featured-rights.server';
import {
  FEATURED_RIGHTS_LICENCES,
  type FeaturedRightsLicence,
  featuredOfflinePermission,
  featuredOfflineReason,
  isOfflineAvailable,
  isOfflineDownloadable,
  OFFLINE_INELIGIBLE_REASONS,
  offlineEligibility,
} from '@/lib/music/offline-eligibility';

const FILE = 'Rock/Band - Brano.mp3';

function manifest(brani: unknown[]) {
  return JSON.stringify({ versione: 1, brani });
}

describe('regola della copia offline: ogni licenza × "offline"', () => {
  const expected: Record<FeaturedRightsLicence, Record<'none' | 'true' | 'false', boolean>> = {
    propria: { none: true, true: true, false: false },
    licenza: { none: false, true: true, false: false },
    cc0: { none: true, true: true, false: false },
    'cc-by': { none: true, true: true, false: false },
    'cc-by-sa': { none: true, true: true, false: false },
    'cc-by-nd': { none: true, true: true, false: false },
  };

  it('le licenze sono le stesse del parser', () => {
    expect([...RIGHTS_LICENSES]).toEqual([...FEATURED_RIGHTS_LICENCES]);
  });

  for (const licenza of FEATURED_RIGHTS_LICENCES) {
    for (const flag of ['none', 'true', 'false'] as const) {
      const offline = flag === 'none' ? undefined : flag === 'true';
      it(`${licenza} con "offline" ${flag} → ${expected[licenza][flag] ? 'scaricabile' : 'solo streaming'}`, () => {
        const entry = offline === undefined ? { licenza } : { licenza, offline };
        const permission = featuredOfflinePermission(entry);
        expect(permission.allowed).toBe(expected[licenza][flag]);
        expect(offlineDeclared(entry)).toBe(expected[licenza][flag]);
        const eligibility = offlineEligibility({ source: 'featured', entry });
        if (expected[licenza][flag]) {
          expect(eligibility).toEqual({ kind: 'featured-download' });
          expect(isOfflineDownloadable(eligibility)).toBe(true);
          expect(isOfflineAvailable(eligibility)).toBe(true);
        } else {
          expect(eligibility.kind).toBe('online-only');
          expect(isOfflineDownloadable(eligibility)).toBe(false);
        }
      });
    }
  }

  it('il perché: licenza, opt-in, opt-out e licenza senza opt-in', () => {
    expect(offlineBasis({ licenza: 'cc-by' })).toBe('licence_default');
    expect(offlineBasis({ licenza: 'licenza', offline: true })).toBe('opt_in');
    expect(offlineBasis({ licenza: 'propria', offline: false })).toBe('opt_out');
    expect(offlineBasis({ licenza: 'licenza' })).toBe('licence_needs_opt_in');
  });

  it('motivi in italiano per i brani solo in streaming', () => {
    expect(offlineEligibility({ source: 'featured', entry: { licenza: 'licenza' } })).toEqual({
      kind: 'online-only',
      reason: OFFLINE_INELIGIBLE_REASONS.featuredStreamingLicence,
    });
    expect(
      offlineEligibility({ source: 'featured', entry: { licenza: 'propria', offline: false } }),
    ).toEqual({
      kind: 'online-only',
      reason:
        'Il titolare non ha concesso la copia offline: questo brano si ascolta solo in streaming.',
    });
    expect(featuredOfflineReason('opt_out')).toBe(OFFLINE_INELIGIBLE_REASONS.featuredDeclined);
    expect(featuredOfflineReason('licence_needs_opt_in')).toContain('streaming');
  });

  it('un brano NON dichiarato non è mai scaricabile (stessa nota di un brano sconosciuto)', () => {
    expect(offlineEligibility({ source: 'featured', entry: null })).toEqual({
      kind: 'online-only',
      reason: OFFLINE_INELIGIBLE_REASONS.featuredUnavailable,
    });
  });

  it('lato client: solo offline true è scaricabile; assente/null = non disponibile', () => {
    expect(offlineEligibility({ source: 'featured-track', offline: true })).toEqual({
      kind: 'featured-download',
    });
    expect(offlineEligibility({ source: 'featured-track', offline: false })).toEqual({
      kind: 'online-only',
      reason: OFFLINE_INELIGIBLE_REASONS.featuredDeclined,
    });
    for (const offline of [undefined, null]) {
      expect(offlineEligibility({ source: 'featured-track', offline })).toEqual({
        kind: 'online-only',
        reason: OFFLINE_INELIGIBLE_REASONS.featuredUnavailable,
      });
    }
  });
});

describe('diritti.json: il campo "offline"', () => {
  it('true, false o assente sono validi (manifest vecchi invariati)', () => {
    const parsed = parseRightsManifest(
      manifest([
        { file: 'A.mp3', licenza: 'licenza', titolare: 'Etichetta', offline: true },
        { file: 'B.mp3', licenza: 'propria', titolare: 'Io', offline: false },
        { file: 'C.mp3', licenza: 'cc0', titolare: 'Autore' },
      ]),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.skipped).toBe(0);
    expect(
      parsed.entries.map((entry) => [entry.file, entry.offline, offlineDeclared(entry)]),
    ).toEqual([
      ['A.mp3', true, true],
      ['B.mp3', false, false],
      ['C.mp3', undefined, true],
    ]);
  });

  it('un valore che non è true/false rende NON valida solo quella voce (nel dubbio si esclude)', () => {
    const parsed = parseRightsManifest(
      manifest([
        { file: 'A.mp3', licenza: 'propria', titolare: 'Io', offline: 'true' },
        { file: 'B.mp3', licenza: 'propria', titolare: 'Io', offline: 1 },
        { file: 'C.mp3', licenza: 'propria', titolare: 'Io' },
      ]),
    );
    expect(parsed.ok && parsed.entries.map((entry) => entry.file)).toEqual(['C.mp3']);
    expect(parsed.ok && parsed.skipped).toBe(2);
  });

  it('doppioni: la copia vale solo se TUTTE le voci la consentono, in qualunque ordine', () => {
    const cases: Array<{ rows: unknown[]; allowed: boolean }> = [
      // propria (sì) + "offline": false (no) → no
      {
        rows: [
          { file: FILE, licenza: 'propria', titolare: 'Io' },
          { file: FILE, licenza: 'propria', titolare: 'Io', offline: false },
        ],
        allowed: false,
      },
      // ordine inverso → no
      {
        rows: [
          { file: FILE, licenza: 'propria', titolare: 'Io', offline: false },
          { file: FILE, licenza: 'propria', titolare: 'Io' },
        ],
        allowed: false,
      },
      // cc-by (sì) + "licenza" senza opt-in (no) → no
      {
        rows: [
          { file: FILE, licenza: 'cc-by', titolare: 'Io' },
          { file: FILE, licenza: 'licenza', titolare: 'Etichetta' },
        ],
        allowed: false,
      },
      // "licenza" con opt-in + propria → sì
      {
        rows: [
          { file: FILE, licenza: 'licenza', titolare: 'Etichetta', offline: true },
          { file: FILE, licenza: 'propria', titolare: 'Io' },
        ],
        allowed: true,
      },
      // forma Unicode diversa dello stesso file (NFD) con "offline": false → no
      {
        rows: [
          { file: 'Novità/Brano.mp3', licenza: 'propria', titolare: 'Io' },
          { file: 'Novità/Brano.mp3', licenza: 'propria', titolare: 'Io', offline: false },
        ],
        allowed: false,
      },
    ];
    for (const { rows, allowed } of cases) {
      const parsed = parseRightsManifest(manifest(rows));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.entries).toHaveLength(1);
      expect(offlineDeclared(parsed.entries[0] as (typeof parsed.entries)[number])).toBe(allowed);
    }
  });

  it('una voce NON valida sullo stesso file spegne copia offline e testo (in qualunque ordine)', () => {
    const variants: unknown[] = [
      // revoca scritta a metà: niente licenza né titolare
      { file: FILE, offline: false },
      // "false" fra virgolette
      { file: FILE, licenza: 'propria', titolare: 'Io', offline: 'false' },
      // licenza di terzi con "offline" scritto male
      { file: FILE, licenza: 'licenza', titolare: 'Etichetta', offline: 'no' },
      // licenza non commerciale (non ammessa)
      { file: FILE, licenza: 'cc-by-nc', titolare: 'Io' },
      // forma Unicode diversa dello stesso file
      { file: FILE.normalize('NFD'), testo: false },
    ];
    const valid = { file: FILE, licenza: 'cc0', titolare: 'Io', testo: true };
    for (const invalid of variants) {
      for (const rows of [
        [valid, invalid],
        [invalid, valid],
      ]) {
        const parsed = parseRightsManifest(manifest(rows));
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) continue;
        expect(parsed.skipped).toBe(1);
        expect(parsed.entries).toHaveLength(1);
        const entry = parsed.entries[0] as (typeof parsed.entries)[number];
        // Il brano resta dichiarato (licenza e titolare della voce valida), senza copia né testo.
        expect(entry).toMatchObject({ file: FILE, licenza: 'cc0', titolare: 'Io', testo: false });
        expect(offlineDeclared(entry)).toBe(false);
      }
    }
  });

  it('una voce non valida su un ALTRO file non tocca le altre', () => {
    const parsed = parseRightsManifest(
      manifest([
        { file: FILE, licenza: 'propria', titolare: 'Io', testo: true },
        { file: 'Altro.mp3', offline: false },
        { titolare: 'senza file' },
      ]),
    );
    expect(parsed.ok && parsed.entries).toEqual([
      { file: FILE, licenza: 'propria', titolare: 'Io', testo: true },
    ]);
  });

  it('la spenta per voce non valida non cambia il perché di una voce che già non la consente', () => {
    const parsed = parseRightsManifest(
      manifest([
        { file: FILE, licenza: 'licenza', titolare: 'Etichetta' },
        { file: FILE, offline: false },
      ]),
    );
    const entry = parsed.ok ? parsed.entries[0] : undefined;
    expect(entry && offlineBasis(entry)).toBe('licence_needs_opt_in');
  });

  it('il doppione spegne la copia ma non tocca il testo (e viceversa)', () => {
    const parsed = parseRightsManifest(
      manifest([
        { file: FILE, licenza: 'propria', titolare: 'Io', testo: true },
        { file: FILE, licenza: 'propria', titolare: 'Io', testo: true, offline: false },
      ]),
    );
    expect(parsed.ok && parsed.entries[0]).toMatchObject({ testo: true, offline: false });
  });
});

describe('diagnosi admin: copia offline', () => {
  it('segnala la voce che spegne la copia e il disaccordo fra i doppioni', () => {
    const diagnosis = diagnoseRightsManifestText(
      manifest([
        { file: FILE, licenza: 'propria', titolare: 'Io' },
        { file: 'Altro.mp3', licenza: 'propria', titolare: 'Io' },
        { file: FILE, licenza: 'propria', titolare: 'Io', offline: false },
      ]),
      [FILE, 'Altro.mp3'],
    );
    expect(diagnosis.status).toBe('valid');
    expect(diagnosis.offlineOffBy.get(FILE)).toBe(3);
    expect(diagnosis.offlineOffBy.has('Altro.mp3')).toBe(false);
    const declared = diagnosis.declared.get(FILE);
    expect(declared && offlineDeclared(declared)).toBe(false);
    const duplicate = diagnosis.problems.find((problem) => problem.index === 3);
    expect(duplicate?.reasons).toContain(
      'le voci dello stesso file non sono d’accordo sulla copia offline: resta spenta (serve il permesso in tutte)',
    );
  });

  it('una voce non valida sullo stesso file: spegne copia e testo e la diagnosi lo dice', () => {
    const diagnosis = diagnoseRightsManifestText(
      manifest([
        { file: 'Altro.mp3', licenza: 'propria', titolare: 'Io' },
        { file: FILE, licenza: 'propria', titolare: 'Io', testo: true },
        { file: FILE, offline: false },
      ]),
      [FILE, 'Altro.mp3'],
    );
    const declared = diagnosis.declared.get(FILE);
    expect(declared && offlineDeclared(declared)).toBe(false);
    expect(declared?.testo).toBe(false);
    expect(diagnosis.offlineOffBy.get(FILE)).toBe(3);
    expect(diagnosis.lyricsOffBy.get(FILE)).toBe(3);
    expect(diagnosis.offlineOffBy.has('Altro.mp3')).toBe(false);
    const problem = diagnosis.problems.find((item) => item.index === 3);
    expect(problem?.kind).toBe('invalid');
    expect(problem?.reasons[0]).toBe(
      'nomina lo stesso file della voce n. 2: finché non la correggi o la togli, testo e copia offline di quel file restano spenti (nel dubbio si esclude)',
    );
    // La diagnosi e il parser vero restano d'accordo.
    const parsed = parseRightsManifest(
      manifest([
        { file: 'Altro.mp3', licenza: 'propria', titolare: 'Io' },
        { file: FILE, licenza: 'propria', titolare: 'Io', testo: true },
        { file: FILE, offline: false },
      ]),
    );
    expect(parsed.ok && parsed.entries[1]).toEqual(declared);
  });

  it('una voce con "offline": false scritta a mano non è un disaccordo', () => {
    const diagnosis = diagnoseRightsManifestText(
      manifest([{ file: FILE, licenza: 'propria', titolare: 'Io', offline: false }]),
      [FILE],
    );
    expect(diagnosis.offlineOffBy.size).toBe(0);
    expect(diagnosis.problems).toEqual([]);
  });

  it('spiega un "offline" scritto male', () => {
    const diagnosis = diagnoseRightsManifestText(
      manifest([{ file: FILE, licenza: 'propria', titolare: 'Io', offline: 'sì' }]),
      [FILE],
    );
    expect(diagnosis.problems[0]?.reasons).toEqual([
      '"offline" deve essere true o false (senza virgolette)',
    ]);
    expect(diagnosis.declared.size).toBe(0);
  });
});

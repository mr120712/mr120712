// @polsia:user-owned — diagnosi della pagina admin «Diritti e testi» (/admin/diritti-testi): per
// ogni "brano in evidenza" dello store Vercel Blob (come lo vede la Home, senza public-uploads/)
// spiega se è ricercabile (voce valida in diritti.json) e, SOLO per i brani dichiarati con
// "testo": true, se il testo c'è e da dove viene (.lrc, .txt, incorporato). È una diagnosi: mai
// il testo dei brani (solo fonte, tipo e numero di righe), mai scorciatoie per dichiarare brani.
//
// Una richiesta = AL MASSIMO un elenco dello store (in cache ~60 secondi, condiviso fra richieste
// concorrenti), una lettura di diritti.json (sempre fresca, con le stesse regole della ricerca) e
// i controlli del testo con la cache del player (featured-lyrics.server): al massimo
// REPORT_MAX_LYRICS_CHECKS controlli nuovi, 3 alla volta, entro ~15 secondi; gli altri risultano
// "da controllare" e un "Aggiorna" successivo li completa (quelli già fatti sono in cache). Una
// lettura fallita in cache si ricontrolla a ogni "Aggiorna", dopo i brani mai controllati.
// Se l'elenco (anche in cache) non ha diritti.json, o lo dà oltre 256 KB, lo si chiede allo store
// per nome (head): un manifest appena caricato o ridotto vale subito, senza un nuovo elenco.
// Per ogni brano DICHIARATO dice anche se la COPIA OFFLINE («Scarica offline») è consentita e
// perché (licenza, "offline": true/false, licenza "licenza" senza "offline": true, doppione):
// stesse regole del parser e della rotta di download.
// Per la trascrizione IA (Whisper) dice solo SE si può usare (`transcriptionAvailable`: chiave
// OpenAI e store presenti) e, per i SOLI brani dichiarati con "testo": true, se formato e
// dimensione sono accettati (`transcription`); gli altri brani non hanno il campo. Il permesso
// vero lo ricontrolla la route della trascrizione a ogni richiesta.
import 'server-only';
import { BlobNotFoundError, head } from '@vercel/blob';
import {
  type AdminFeaturedRights,
  FEATURED_RIGHTS_MAX_PROBLEMS,
  FEATURED_RIGHTS_MAX_TRACKS,
  type FeaturedRightsLyrics,
  type FeaturedRightsTrack,
} from '@/lib/contracts/admin-featured-rights';
import { TRANSCRIPTION_MAX_AUDIO_BYTES } from '@/lib/contracts/lyrics-transcription';
import { env } from '@/lib/env';
import {
  type FeaturedLyricsAvailability,
  getFeaturedLyricsAvailability,
  peekFeaturedLyricsAvailability,
} from '@/lib/music/featured-lyrics.server';
import {
  declaredGenre,
  diagnoseRightsManifest,
  lyricsDeclared,
  offlineBasis,
  offlineDeclared,
  RIGHTS_MANIFEST_MAX_BYTES,
  RIGHTS_MANIFEST_PATHNAME,
} from '@/lib/music/featured-rights.server';
import type { FeaturedLyricsSource } from '@/lib/music/featured-search.server';
import {
  type HomeStoreFile,
  type HomeTrackCatalog,
  listHomeTrackCatalog,
  lyricsSidecarMatcher,
  sectionTitleFromDirectory,
} from '@/lib/music/home-tracks.server';
import { isWhisperConfigured, whisperExtension } from '@/lib/music/whisper.server';

/** Un elenco completo dello store resta valido ~1 minuto; uno parziale ~15 secondi. */
const LISTING_TTL_MS = 60_000;
const PARTIAL_LISTING_TTL_MS = 15_000;
/** Controlli del testo NUOVI (non in cache) al massimo per richiesta. */
export const REPORT_MAX_LYRICS_CHECKS = 50;
/** Controlli del testo in parallelo. */
export const REPORT_LYRICS_CONCURRENCY = 3;
/** Tempo massimo complessivo dei controlli del testo di una richiesta. */
export const REPORT_LYRICS_DEADLINE_MS = 15_000;
/** Tempo massimo per chiedere allo store diritti.json per nome. */
const MANIFEST_HEAD_DEADLINE_MS = 4000;

export type FeaturedRightsReportOptions = {
  maxChecks?: number;
  concurrency?: number;
  deadlineMs?: number;
};

type ListingSnapshot = { catalog: HomeTrackCatalog; listedAt: Date };

let cachedListing: { snapshot: ListingSnapshot; expiresAt: number } | null = null;
let listing: Promise<ListingSnapshot | null> | null = null;
/** Cambia a ogni svuotamento: un elenco partito prima non scrive più nella cache. */
let generation = 0;

/** Butta l'elenco in cache: il prossimo «Aggiorna» rilegge lo store (dopo «Aggiorna ora»). */
export function invalidateFeaturedRightsReportListing() {
  cachedListing = null;
  listing = null;
  generation += 1;
}

/** Svuota la cache dell'elenco (solo per i test). */
export function clearFeaturedRightsReportCacheForTests() {
  invalidateFeaturedRightsReportListing();
}

/** L'elenco dello store dalla cache, oppure letto UNA volta anche con più richieste insieme. */
async function loadListing(): Promise<ListingSnapshot | null> {
  if (cachedListing && cachedListing.expiresAt > Date.now()) return cachedListing.snapshot;
  if (!listing) {
    const started = generation;
    const current: Promise<ListingSnapshot | null> = listHomeTrackCatalog([
      RIGHTS_MANIFEST_PATHNAME,
    ])
      .then((catalog) => {
        if (!catalog) return null;
        const snapshot = { catalog, listedAt: new Date() };
        if (started === generation) {
          const ttl = catalog.complete ? LISTING_TTL_MS : PARTIAL_LISTING_TTL_MS;
          cachedListing = { snapshot, expiresAt: Date.now() + ttl };
        }
        return snapshot;
      })
      .catch(() => null)
      .finally(() => {
        if (listing === current) listing = null;
      });
    listing = current;
  }
  return listing;
}

function abortAfter(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined;
}

/**
 * diritti.json chiesto allo store per nome: il file, null se lo store dice che non c'è, undefined
 * se non risponde in tempo o in errore (allora vale l'elenco).
 */
async function headManifest(token: string): Promise<HomeStoreFile | null | undefined> {
  const lookup = head(RIGHTS_MANIFEST_PATHNAME, {
    token,
    abortSignal: abortAfter(MANIFEST_HEAD_DEADLINE_MS),
  }).then(
    (blob): HomeStoreFile | undefined =>
      blob.pathname === RIGHTS_MANIFEST_PATHNAME
        ? { pathname: blob.pathname, url: blob.url, size: blob.size, uploadedAt: blob.uploadedAt }
        : undefined,
    (error: unknown) => (error instanceof BlobNotFoundError ? null : undefined),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), MANIFEST_HEAD_DEADLINE_MS);
  });
  try {
    return await Promise.race([lookup, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function directoryOf(pathname: string): string {
  const slash = pathname.lastIndexOf('/');
  return slash > 0 ? pathname.slice(0, slash) : '';
}

function extensionOf(pathname: string): string {
  return pathname.slice(pathname.lastIndexOf('.') + 1).toLowerCase();
}

/** Solo fonte, tipo e righe: si copia campo per campo, così nient'altro può uscire. */
function toLyrics(availability: FeaturedLyricsAvailability): FeaturedRightsLyrics {
  if ('kind' in availability) {
    return {
      status: availability.status,
      kind: availability.kind,
      lineCount: availability.lineCount,
      ...(availability.sidecarError === true ? { sidecarError: true as const } : {}),
    };
  }
  return { status: availability.status };
}

/** `fallback` = esito già in cache (lettura fallita) che resta se il ricontrollo non avviene. */
type LyricsCheck = {
  row: FeaturedRightsTrack;
  source: FeaturedLyricsSource;
  fallback?: FeaturedRightsLyrics;
};

const SKIPPED: FeaturedRightsLyrics = { status: 'skipped' };

/** Controlla il testo dei brani in coda: tetto, parallelismo e scadenza; il resto è "skipped". */
async function checkLyrics(
  queue: readonly LyricsCheck[],
  { maxChecks, concurrency, deadlineMs }: Required<FeaturedRightsReportOptions>,
): Promise<void> {
  const batch = queue.slice(0, Math.max(0, maxChecks));
  for (const item of queue.slice(batch.length)) item.row.lyrics = item.fallback ?? SKIPPED;
  if (batch.length === 0) return;

  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve('timeout');
    }, deadlineMs);
  });
  let next = 0;
  const worker = async () => {
    while (!expired) {
      const item = batch[next];
      next += 1;
      if (!item) return;
      const result = await Promise.race([
        getFeaturedLyricsAvailability(item.source).catch(
          (): FeaturedLyricsAvailability => ({ status: 'error' }),
        ),
        deadline,
      ]);
      // Un controllo oltre la scadenza continua da solo e finisce nella cache: "Aggiorna" lo trova.
      item.row.lyrics = result === 'timeout' ? (item.fallback ?? SKIPPED) : toLyrics(result);
    }
  };
  try {
    const workers = Math.min(Math.max(1, Math.floor(concurrency)), batch.length);
    await Promise.all(Array.from({ length: workers }, worker));
  } finally {
    clearTimeout(timer);
  }
  for (const item of batch) {
    if (item.row.lyrics.status === 'not_checked') item.row.lyrics = item.fallback ?? SKIPPED;
  }
}

const EMPTY_SUMMARY: AdminFeaturedRights['summary'] = {
  totalTracks: 0,
  declared: 0,
  declaredWithLyrics: 0,
  lyricsFound: 0,
  lyricsMissing: 0,
  lyricsErrors: 0,
  lyricsSkipped: 0,
  lyricsNotShown: 0,
  manifestProblems: 0,
};

function unavailableReport(generatedAt: string, reason: string): AdminFeaturedRights {
  return {
    generatedAt,
    store: { status: 'unavailable', listedAt: null, reason },
    manifest: {
      status: 'unavailable',
      reasons: [reason],
      location: null,
      counts: { entries: 0, valid: 0, invalid: 0, ignored: 0 },
      problems: [],
    },
    summary: { ...EMPTY_SUMMARY },
    tracks: [],
    tracksTruncated: false,
    transcriptionAvailable: false,
  };
}

/**
 * La diagnosi completa per la pagina admin. Non fa throw per problemi dello store (diventano
 * stati 'unavailable'/'partial' nella risposta); il permesso di vedere il testo NON c'entra: il
 * testo non esce mai, si controlla solo se esiste per i brani dichiarati con "testo": true.
 */
export async function buildFeaturedRightsReport(
  options: FeaturedRightsReportOptions = {},
): Promise<AdminFeaturedRights> {
  const limits: Required<FeaturedRightsReportOptions> = {
    maxChecks: options.maxChecks ?? REPORT_MAX_LYRICS_CHECKS,
    concurrency: options.concurrency ?? REPORT_LYRICS_CONCURRENCY,
    deadlineMs: options.deadlineMs ?? REPORT_LYRICS_DEADLINE_MS,
  };
  const generatedAt = new Date().toISOString();
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    return unavailableReport(
      generatedAt,
      'Vercel Blob non è configurato (manca BLOB_READ_WRITE_TOKEN): nessun brano in evidenza.',
    );
  }
  const snapshot = await loadListing();
  if (!snapshot) {
    return unavailableReport(
      generatedAt,
      'Non riesco a elencare lo store Vercel Blob in questo momento: riprova tra poco.',
    );
  }

  const { catalog, listedAt } = snapshot;
  // L'elenco può avere fino a ~1 minuto: un diritti.json appena caricato (o appena ridotto sotto
  // 256 KB) si cerca per nome, senza rifare l'elenco. Se lo store conferma che non c'è, vale
  // "missing" anche con un elenco parziale.
  let manifestFile = catalog.files.get(RIGHTS_MANIFEST_PATHNAME) ?? null;
  let manifestConfirmed = false;
  if (!manifestFile || manifestFile.size > RIGHTS_MANIFEST_MAX_BYTES) {
    const fresh = await headManifest(token).catch(() => undefined);
    if (fresh !== undefined) {
      manifestFile = fresh;
      manifestConfirmed = true;
    }
  }
  // Stessa lettura e stesse regole della ricerca, sugli stessi brani dello stesso elenco.
  const diagnosis = await diagnoseRightsManifest(
    token,
    manifestFile,
    catalog.tracks.map((track) => track.id),
    {
      // Solo la presenza del manifest è confermata: "file non trovato" dipende sempre dall'elenco.
      listingComplete: catalog.complete || (manifestConfirmed && manifestFile === null),
    },
  );
  const sidecarsFor = lyricsSidecarMatcher(catalog.sidecars);

  const rows: FeaturedRightsTrack[] = [];
  const queue: LyricsCheck[] = [];
  // Letture fallite già in cache: si ricontrollano DOPO i brani mai controllati.
  const retries: LyricsCheck[] = [];
  let declared = 0;
  let declaredWithLyrics = 0;
  let lyricsNotShown = 0;
  let offlineAllowed = 0;
  for (const [position, track] of catalog.tracks.entries()) {
    const entry = diagnosis.declared.get(track.id);
    const testo = entry ? lyricsDeclared(entry) : false;
    if (entry) declared += 1;
    if (testo) declaredWithLyrics += 1;
    if (entry && offlineDeclared(entry)) offlineAllowed += 1;
    if (position >= FEATURED_RIGHTS_MAX_TRACKS) {
      if (testo) lyricsNotShown += 1;
      continue;
    }

    const sidecars = sidecarsFor(track.id);
    const folder = directoryOf(track.id);
    const row: FeaturedRightsTrack = {
      pathname: track.id,
      folder,
      section: sectionTitleFromDirectory(folder, true),
      title: track.title,
      artist: track.artist,
      declared: Boolean(entry),
      licenza: entry?.licenza ?? null,
      titolare: entry?.titolare ?? null,
      testo,
      testoOffBy: diagnosis.lyricsOffBy.get(track.id) ?? null,
      sidecars: {
        lrc: sidecars.some((file) => extensionOf(file.pathname) === 'lrc'),
        txt: sidecars.some((file) => extensionOf(file.pathname) === 'txt'),
      },
      lyrics: { status: 'not_checked' },
    };
    // Copia offline: solo per i brani dichiarati (stessa regola della rotta di download).
    if (entry) {
      row.offline = {
        allowed: offlineDeclared(entry),
        basis: offlineBasis(entry),
        offBy: diagnosis.offlineOffBy.get(track.id) ?? null,
      };
      // Genere della fila «Per genere» (solo dichiarati, come la Home): quello della voce che vale.
      row.genere = declaredGenre(entry);
    }
    rows.push(row);
    // Il testo si cerca SOLO per i brani dichiarati con "testo": true (come fa il player).
    if (!entry || !testo) continue;
    // Solo qui la trascrizione IA esiste: per gli altri brani il campo manca.
    const audioSize = catalog.audioSizes?.get(track.id) ?? 0;
    row.transcription = !whisperExtension(track.id)
      ? 'unsupported_format'
      : audioSize > TRANSCRIPTION_MAX_AUDIO_BYTES
        ? 'too_large'
        : 'ready';
    const source: FeaturedLyricsSource = {
      pathname: track.id,
      holder: entry.titolare,
      // Come l'indice della ricerca: stream diretto dal CDN = file pubblico.
      audioPublic: /^https:\/\//.test(track.streamUrl),
      sidecars,
    };
    const cached = peekFeaturedLyricsAvailability(source);
    if (!cached) queue.push({ row, source });
    else {
      row.lyrics = toLyrics(cached);
      if (cached.status === 'error') retries.push({ row, source, fallback: row.lyrics });
    }
  }
  await checkLyrics([...queue, ...retries], limits);

  const count = (statuses: readonly FeaturedRightsLyrics['status'][]) =>
    rows.filter((row) => statuses.includes(row.lyrics.status)).length;

  return {
    generatedAt,
    store: {
      status: catalog.complete ? 'ok' : 'partial',
      listedAt: listedAt.toISOString(),
      reason: catalog.complete
        ? null
        : 'Elenco dello store incompleto (errore, tempo scaduto o troppi file): alcuni brani potrebbero mancare.',
    },
    manifest: {
      status: diagnosis.status,
      reasons: diagnosis.reasons.slice(0, 20),
      location: diagnosis.location,
      counts: { ...diagnosis.counts },
      problems: diagnosis.problems.slice(0, FEATURED_RIGHTS_MAX_PROBLEMS).map((problem) => ({
        index: problem.index,
        file: problem.file,
        kind: problem.kind,
        reasons: problem.reasons,
      })),
    },
    summary: {
      totalTracks: catalog.tracks.length,
      declared,
      declaredWithLyrics,
      lyricsFound: count(['lrc', 'txt', 'embedded']),
      lyricsMissing: count(['none']),
      lyricsErrors: count(['error']),
      lyricsSkipped: count(['skipped']),
      lyricsNotShown,
      manifestProblems: diagnosis.problems.length,
      offlineAllowed,
    },
    tracks: rows,
    tracksTruncated: catalog.tracks.length > rows.length,
    transcriptionAvailable: isWhisperConfigured(),
  };
}

// @polsia:user-owned — diritti dei "brani in evidenza" per la RICERCA. Legge il manifest
// `diritti.json` che l'amministratore carica nella RADICE dello stesso store Vercel Blob dei brani
// (dal pannello Vercel, come i brani). La ricerca globale mostra SOLO i brani dichiarati qui: un
// file presente nello store ma assente dal manifest resta in Home (che non cambia) ma non si trova
// cercando. Nel dubbio si esclude: manifest assente, illeggibile, non valido o oltre 256 KB = nessun
// brano in evidenza ricercabile.
//
// COME SCRIVERE diritti.json (testo UTF-8, JSON valido, massimo 256 KB, caricato come PRIVATO:
// un file privato si legge sempre dall'origine, uno pubblico passa dal CDN di Vercel Blob e una
// modifica o revoca può arrivare in ritardo):
//
//   {
//     "versione": 1,
//     "brani": [
//       {
//         "file": "Rock italiano/Artista - Titolo.mp3",
//         "licenza": "propria",
//         "titolare": "Artista",
//         "genere": "Rock italiano"
//       },
//       {
//         "file": "Novità/Band - Singolo.flac",
//         "licenza": "licenza",
//         "titolare": "Etichetta Srl",
//         "prova": "Contratto di distribuzione n. 42 del 03/2026"
//       },
//       {
//         "file": "Cantautori/Autrice - Canzone.mp3",
//         "licenza": "propria",
//         "titolare": "Autrice",
//         "testo": true,
//         "genere": "Cantautorato"
//       },
//       {
//         "file": "Strumentale - Pioggia.mp3",
//         "licenza": "cc-by",
//         "titolare": "Strumentale",
//         "prova": "https://creativecommons.org/licenses/by/4.0/"
//       },
//       {
//         "file": "Novità/Band - Remix.mp3",
//         "licenza": "licenza",
//         "titolare": "Etichetta Srl",
//         "prova": "Contratto n. 43: streaming e download offline",
//         "offline": true
//       }
//     ]
//   }
//
// - "versione": sempre 1.
// - "file": il pathname ESATTO del file audio nello store, come lo mostra il pannello Blob (cartelle
//   comprese, maiuscole e spazi identici, con l'estensione). Niente "/" iniziale, niente "..", niente
//   indirizzi web, niente file sotto "public-uploads/" (sono gli upload degli utenti) e solo file
//   audio (mp3, m4a, m4b, aac, ogg, oga, opus, wav, flac, webm, weba). Il file deve esistere.
// - "licenza": uno di
//     "propria"  → il brano è tuo (ne detieni tutti i diritti);
//     "licenza"  → licenza ottenuta per contratto (etichetta, distributore, editore);
//     "cc0"      → pubblico dominio Creative Commons Zero;
//     "cc-by", "cc-by-sa", "cc-by-nd" → Creative Commons che ammettono l'uso commerciale.
//   Le licenze NON commerciali (cc-by-nc, cc-by-nc-sa, cc-by-nc-nd) NON sono accettate: Solco vende
//   abbonamenti Pro, quindi l'uso è commerciale.
// - "titolare": chi detiene i diritti (da 1 a 120 caratteri).
// - "genere": facoltativo, il genere del brano (da 1 a 40 caratteri, es. "Rap italiano"). In Home i
//   brani dichiarati con lo stesso genere (maiuscole e spazi doppi non contano) formano un riquadro
//   della fila «Per genere» (prima i generi con più brani), che apre la pagina con tutti i brani
//   dichiarati di quel genere. Senza "genere" il brano resta solo nella sua cartella. Non è un permesso: con
//   più voci per lo stesso file vale il genere della prima. Un "genere" scritto male (non un testo,
//   vuoto, oltre 40 caratteri, con un a capo) rende NON valida tutta la voce, come gli altri campi.
// - "prova": facoltativa, una nota o un link al contratto/licenza (al massimo 300 caratteri).
// - "testo": facoltativo, true o false (se manca vale false). Con true il player mostra il TESTO
//   del brano (stile Spotify), letto da un file accanto all'audio con lo stesso nome ed estensione
//   .lrc (sincronizzato) o .txt (semplice), es. "Cantautori/Autrice - Canzone.lrc", oppure, in
//   mancanza, dal testo incorporato nel file audio (tag USLT/SYLT degli MP3, LYRICS dei FLAC/OGG,
//   ©lyr degli M4A). ATTENZIONE: il testo è un'opera letteraria separata dalla registrazione e
//   appartiene ad autori ed editori musicali. Una licenza sulla registrazione ("licenza" con
//   un'etichetta o un distributore) spesso NON comprende il testo: metti "testo": true SOLO se
//   anche questi diritti sono coperti (brano tuo con testo tuo, contratto che include il testo,
//   accordo con l'editore). Nel dubbio lascialo fuori: Solco non mostra testi presi altrove.
//   Il file .lrc/.txt va caricato come PRIVATO (UTF-8, al massimo 64 KB); non compare mai fra i
//   brani o le copertine della Home. Una revoca ("testo" tolto o false) vale di solito entro
//   ~30-90 secondi (cambia la versione del catalogo), al più ~5 minuti.
// - "offline": facoltativo, true o false. Decide la COPIA OFFLINE («Scarica offline»: l'ascoltatore
//   con un account salva il brano in «La tua musica» sul suo dispositivo, con l'attribuzione):
//     · licenza "propria", "cc0", "cc-by", "cc-by-sa", "cc-by-nd" → consentita, salvo "offline": false;
//     · licenza "licenza" (contratto con terzi) → consentita SOLO con "offline": true: una licenza
//       di streaming non comprende per forza il download, quindi mettilo solo se il contratto copre
//       anche la copia offline;
//     · "offline": false → mai, qualunque sia la licenza.
//   Un brano NON dichiarato (assente, voce non valida, manifest assente o non valido) non si scarica
//   mai, da nessuna parte (pulsanti, API, cartella, artista, link diretto, player). Per le Creative
//   Commons la copia porta in «La tua musica» titolare, nome della licenza e link al testo della
//   licenza: il link è "prova" se è un indirizzo creativecommons.org della stessa licenza (es.
//   https://creativecommons.org/licenses/by/4.0/), altrimenti la versione 4.0. La rotta di download
//   ricontrolla questo manifest (letto di nuovo dallo store) a OGNI download. Senza "testo": true
//   la copia NON porta il testo incorporato nel file (i tag del testo si tolgono prima dell'invio; se
//   non si riesce a toglierlo, quel brano resta solo in streaming). Le copie già salvate si
//   ricontrollano quando l'ascoltatore apre Solco da online (qualunque pagina): un brano revocato
//   ("offline": false, voce tolta, licenza cambiata in "licenza" senza "offline": true) sparisce dai
//   dispositivi di solito entro ~30-90 secondi dalla revoca, al più ~6 minuti (stessi tempi della
//   ricerca). Un
//   diritti.json NON valido o assente = nessun brano dichiarato: anche le copie offline vengono
//   tolte alla verifica successiva (nel dubbio si esclude), quindi controllalo nella pagina admin
//   prima di caricarlo. Una copia su un dispositivo che resta sempre offline non si può revocare
//   finché non torna online.
// - Nessun altro campo: un campo in più rende NON valida quella voce (o tutto il manifest, se è al
//   primo livello). Una voce non valida viene ignorata da sola, le altre restano; una voce ripetuta
//   conta una volta (vale la prima), ma il testo si mostra solo se TUTTE le voci di quel file
//   hanno "testo": true, e la copia offline vale solo se TUTTE le voci di quel file la consentono.
//   Per REVOCARE aggiungendo una voce in fondo, scrivila COMPLETA (file, licenza, titolare e
//   "offline": false o "testo": false). Una voce NON valida che nomina lo stesso file di una voce
//   valida (es. {"file": …, "offline": false} senza licenza, o "offline": "false" fra virgolette)
//   spegne comunque testo e copia offline di quel file, nel dubbio, finché non la correggi o la
//   togli: il brano resta dichiarato e la pagina admin indica la voce.
// - Tempi (cache): diritti.json fa parte della versione del catalogo (featured-catalog.server),
//   quindi una REVOCA vale nella ricerca di solito entro ~30-90 secondi, comunque mai oltre i ~6
//   minuti di prima, con il manifest privato; da pubblico si aggiunge la propagazione del CDN. Un
//   brano appena dichiarato compare di solito entro un minuto, fino a ~20 per una ricerca già in
//   cache. «Aggiorna ora» nella pagina admin «Diritti e testi» lo anticipa. Dettagli in
//   featured-search.server.ts.
//
// Un brano scaricato da siti che copiano Spotify (o comunque senza licenza) NON va dichiarato.
//
// La pagina admin «Diritti e testi» (/admin/diritti-testi) spiega voce per voce che cosa vale e
// perché, con diagnoseRightsManifest: stessi schemi e stesse regole di questo parser (in fondo).
import 'server-only';
import { get } from '@vercel/blob';
import { z } from 'zod';
import {
  FEATURED_GENRE_NAME_MAX,
  featuredGenreLabel,
  isFeaturedGenreName,
} from '@/lib/music/featured-genres';
import {
  encodeBlobPathname,
  type HomeStoreFile,
  isHomeAudioBlob,
  isPublicBlobUrl,
  isSafeBlobPathname,
} from '@/lib/music/home-tracks.server';
import {
  FEATURED_RIGHTS_LICENCES,
  type FeaturedOfflineBasis,
  featuredOfflinePermission,
} from '@/lib/music/offline-eligibility';

/** Nome del manifest, nella radice dello store Blob. */
export const RIGHTS_MANIFEST_PATHNAME = 'diritti.json';
/** Dimensione massima del manifest: oltre, nessun brano è ricercabile. */
export const RIGHTS_MANIFEST_MAX_BYTES = 256 * 1024;
/** Tempo massimo per leggere il manifest dallo store (la ricerca non aspetta oltre). */
const MANIFEST_DEADLINE_MS = 4000;
/** Tetto alle voci (256 KB ne contengono comunque poche migliaia). */
const MAX_ENTRIES = 5000;

/**
 * Licenze accettate. Mai le Creative Commons non commerciali (NC). Lo stesso elenco della regola
 * della copia offline (offline-eligibility), così le due non possono divergere.
 */
export const RIGHTS_LICENSES = FEATURED_RIGHTS_LICENCES;

const RightsEntrySchema = z
  .object({
    file: z.string().min(1).max(1024),
    licenza: z.enum(RIGHTS_LICENSES),
    titolare: z.string().trim().min(1).max(120),
    prova: z.string().trim().max(300).optional(),
    // Testo del brano mostrabile nel player: solo con true (assente = false, manifest vecchi validi).
    testo: z.boolean().optional(),
    // Copia offline: assente = regola della licenza, true = concessa, false = mai (vedi sopra).
    offline: z.boolean().optional(),
    // Genere per la fila «Per genere» della Home (solo brani dichiarati): testo senza a capo.
    genere: z
      .string()
      .trim()
      .min(1)
      .max(FEATURED_GENRE_NAME_MAX)
      .refine(isFeaturedGenreName)
      .optional(),
  })
  .strict();
export type RightsEntry = z.infer<typeof RightsEntrySchema>;

/** Il genere della voce come si mostra (spazi sistemati), o null se la voce non lo dice. */
export function declaredGenre(entry: Pick<RightsEntry, 'genere'>): string | null {
  if (typeof entry.genere !== 'string') return null;
  const label = featuredGenreLabel(entry.genere);
  return label.length > 0 ? label : null;
}

/** True solo se la voce dichiara esplicitamente i diritti sul TESTO del brano ("testo": true). */
export function lyricsDeclared(entry: Pick<RightsEntry, 'testo'>): boolean {
  return entry.testo === true;
}

/**
 * True se la voce (che vale) consente la COPIA OFFLINE del brano: la regola è
 * featuredOfflinePermission (licenza + "offline"); i doppioni l'hanno già spenta con
 * "offline": false se anche una sola voce dello stesso file non la consente.
 */
export function offlineDeclared(entry: Pick<RightsEntry, 'licenza' | 'offline'>): boolean {
  return featuredOfflinePermission(entry).allowed;
}

/** Perché la voce consente (o no) la copia offline (per la pagina admin «Diritti e testi»). */
export function offlineBasis(
  entry: Pick<RightsEntry, 'licenza' | 'offline'>,
): FeaturedOfflineBasis {
  return featuredOfflinePermission(entry).basis;
}

const RightsManifestSchema = z
  .object({
    versione: z.literal(1),
    // Le voci si validano una per una (sotto): una voce sbagliata non annulla le altre.
    brani: z.array(z.unknown()).max(MAX_ENTRIES),
  })
  .strict();

export type RightsManifestParse =
  | { ok: true; entries: RightsEntry[]; skipped: number }
  | { ok: false };

/** Struttura del manifest: l'elenco "brani" grezzo, oppure perché il manifest non vale. */
type ManifestStructure =
  | { ok: true; brani: unknown[] }
  | { ok: false; problem: { type: 'json'; error: unknown; source: string } }
  | { ok: false; problem: { type: 'shape'; issues: readonly z.ZodIssue[] } };

/** JSON e primo livello del manifest (versione, nessun campo in più, "brani" elenco). */
function parseManifestStructure(text: string): ManifestStructure {
  // Il BOM UTF-8 (Blocco note di Windows) non è JSON: si toglie.
  const source = text.replace(/^﻿/, '');
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    return { ok: false, problem: { type: 'json', error, source } };
  }
  const manifest = RightsManifestSchema.safeParse(raw);
  if (!manifest.success)
    return { ok: false, problem: { type: 'shape', issues: manifest.error.issues } };
  return { ok: true, brani: manifest.data.brani };
}

/** Che cosa ha deciso il parser per una voce di "brani" (lo legge solo la diagnosi admin). */
type EntryVerdict =
  /**
   * Voce tenuta: è `entries[position]` (con "testo" e "offline" eventualmente spenti da un
   * doppione); `entry` è la voce COM'È SCRITTA.
   */
  | { kind: 'kept'; entry: RightsEntry; position: number }
  /**
   * Scartata: `issues` dello schema, oppure vuoto = schema valido ma percorso non ammesso.
   * `position`: la voce tenuta dello STESSO file (forma NFC), a cui questa voce non valida ha
   * spento testo e copia offline; assente se nessuna voce valida nomina quel file.
   */
  | { kind: 'invalid'; issues: readonly z.ZodIssue[]; position?: number }
  /** Doppione (stessa forma NFC) della voce tenuta in `entries[position]`. */
  | { kind: 'duplicate'; entry: RightsEntry; position: number };

/**
 * Le regole delle voci, UNA volta sola per il parser vero e per la diagnosi dell'amministratore:
 * `observe` (facoltativo) riceve la decisione presa per ogni voce, senza cambiarla.
 */
function collectRightsEntries(
  brani: readonly unknown[],
  observe?: (index: number, row: unknown, verdict: EntryVerdict) => void,
): { entries: RightsEntry[]; skipped: number } {
  // Forma NFC del file → posizione della voce tenuta in `entries`.
  const seen = new Map<string, number>();
  const entries: RightsEntry[] = [];
  // Voci non valide che nominano comunque un file (forma NFC → loro indici in "brani"): se una
  // voce valida dichiara lo stesso file, testo e copia offline di quel file si spengono (sotto).
  const doubtful = new Map<string, number[]>();
  // Le decisioni si comunicano a `observe` alla fine, nell'ordine del manifest, quando si sa già
  // quale voce tenuta una voce non valida contraddice.
  const verdicts: Array<{ index: number; row: unknown; verdict: EntryVerdict }> = [];
  let skipped = 0;
  for (let index = 0; index < brani.length; index += 1) {
    const row = brani[index];
    const parsed = RightsEntrySchema.safeParse(row);
    // Stessa regola dei brani della Home e del proxy di streaming: niente "..", percorsi assoluti,
    // barre rovesciate, caratteri di controllo, upload degli utenti o file non audio.
    if (!parsed.success || !isHomeAudioBlob(parsed.data.file)) {
      skipped += 1;
      const file =
        typeof row === 'object' && row !== null ? (row as { file?: unknown }).file : undefined;
      if (typeof file === 'string' && file.length > 0 && file.length <= 1024) {
        const key = file.normalize('NFC');
        doubtful.set(key, [...(doubtful.get(key) ?? []), index]);
      }
      verdicts.push({
        index,
        row,
        verdict: { kind: 'invalid', issues: parsed.success ? [] : parsed.error.issues },
      });
      continue;
    }
    const key = parsed.data.file.normalize('NFC');
    const keptAt = seen.get(key);
    if (keptAt !== undefined) {
      // Voce ripetuta (anche solo nella forma Unicode): conta la prima, ma il TESTO vale solo se
      // TUTTE le voci di quel file dicono "testo": true, e la COPIA OFFLINE solo se TUTTE la
      // consentono (ognuna con la sua licenza e il suo "offline"). Nel dubbio si esclude,
      // qualunque sia l'ordine: una voce aggiunta in fondo con "testo": false o "offline": false
      // revoca il testo o la copia offline (se è scritta male, vedi le voci "dubbie" qui sotto).
      let kept = entries[keptAt];
      if (kept && kept.testo === true && parsed.data.testo !== true) {
        kept = { ...kept, testo: false };
      }
      if (kept && offlineDeclared(kept) && !offlineDeclared(parsed.data)) {
        kept = { ...kept, offline: false };
      }
      if (kept) entries[keptAt] = kept;
      verdicts.push({
        index,
        row,
        verdict: { kind: 'duplicate', entry: parsed.data, position: keptAt },
      });
      continue;
    }
    seen.set(key, entries.length);
    verdicts.push({
      index,
      row,
      verdict: { kind: 'kept', entry: parsed.data, position: entries.length },
    });
    entries.push(parsed.data);
  }
  // Una voce NON valida sullo stesso file di una voce valida (es. una revoca scritta a metà,
  // {"file": …, "offline": false} senza licenza, o "offline": "false" fra virgolette): nel dubbio
  // si esclude, in qualunque ordine. Testo e copia offline di quel file restano spenti finché la
  // voce non viene corretta o tolta; il brano resta dichiarato (ricerca, Home, streaming).
  const contradicted = new Map<number, number>();
  for (const [key, indexes] of doubtful) {
    const keptAt = seen.get(key);
    const kept = keptAt === undefined ? undefined : entries[keptAt];
    if (keptAt === undefined || !kept) continue;
    let next = kept;
    if (next.testo === true) next = { ...next, testo: false };
    if (offlineDeclared(next)) next = { ...next, offline: false };
    entries[keptAt] = next;
    for (const index of indexes) contradicted.set(index, keptAt);
  }
  if (observe) {
    for (const { index, row, verdict } of verdicts) {
      const position = contradicted.get(index);
      observe(
        index,
        row,
        verdict.kind === 'invalid' && position !== undefined ? { ...verdict, position } : verdict,
      );
    }
  }
  return { entries, skipped };
}

/**
 * Valida il testo del manifest. Struttura sbagliata (JSON non valido, versione diversa da 1, campi
 * in più al primo livello, "brani" non è un elenco) → { ok: false }: nessun brano ricercabile.
 * Ogni voce non valida (campi mancanti o in più, licenza non ammessa, percorso non sicuro, non
 * audio o sotto public-uploads/) è scartata da sola e contata in `skipped`; i doppioni collassano.
 */
export function parseRightsManifest(text: string): RightsManifestParse {
  const structure = parseManifestStructure(text);
  if (!structure.ok) return { ok: false };
  const { entries, skipped } = collectRightsEntries(structure.brani);
  return { ok: true, entries, skipped };
}

/**
 * I pathname dei brani dello store coperti da una voce del manifest. Il confronto è esatto; in
 * alternativa vale la stessa forma Unicode (NFC), perché un nome con accenti caricato da un Mac
 * può arrivare scomposto (NFD) mentre nel manifest è scritto composto — ma solo se quella forma
 * individua UN solo file. Una voce che non corrisponde a nessun file esistente non rende
 * ricercabile nulla.
 */
export function declaredTrackIds(
  entries: readonly RightsEntry[],
  audioPathnames: Iterable<string>,
): Set<string> {
  return new Set(declaredTrackEntries(entries, audioPathnames).keys());
}

/**
 * Come declaredTrackIds, ma con la voce del manifest di ogni file coperto (stesse regole di
 * corrispondenza): serve a leggere "titolare" e "testo" del brano.
 */
export function declaredTrackEntries(
  entries: readonly RightsEntry[],
  audioPathnames: Iterable<string>,
): Map<string, RightsEntry> {
  const exact = new Set(audioPathnames);
  const byNormalForm = new Map<string, string | null>();
  for (const pathname of exact) {
    const key = pathname.normalize('NFC');
    // null = due file diversi con la stessa forma NFC: serve la corrispondenza esatta.
    byNormalForm.set(key, byNormalForm.has(key) ? null : pathname);
  }
  const declared = new Map<string, RightsEntry>();
  for (const entry of entries) {
    if (exact.has(entry.file)) {
      if (!declared.has(entry.file)) declared.set(entry.file, entry);
      continue;
    }
    const match = byNormalForm.get(entry.file.normalize('NFC'));
    if (match && !declared.has(match)) declared.set(match, entry);
  }
  return declared;
}

/** Esito della lettura: `ok` con le voci valide, altrimenti perché nessun brano è ricercabile. */
export type RightsManifestRead =
  | { status: 'ok'; entries: RightsEntry[]; skipped: number }
  | { status: 'missing' | 'invalid' | 'oversize' | 'unavailable' };

function abortAfter(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined;
}

/** Legge lo stream fino a `limit` byte (poi lo chiude): mai più del necessario in memoria. */
export async function readUpTo(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const room = limit - total;
      const piece = value.length > room ? value.subarray(0, room) : value;
      chunks.push(piece);
      total += piece.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Il testo del manifest già controllato (dimensione, UTF-8), oppure perché non si può usare. */
type ManifestTextRead =
  | { status: 'text'; text: string }
  | { status: 'missing' | 'oversize' | 'unavailable' }
  | { status: 'invalid'; cause: 'utf8' };

async function fetchManifestText(
  token: string,
  file: HomeStoreFile,
  deadlineMs: number,
): Promise<ManifestTextRead> {
  // Pubblico o privato come il file elencato. `useCache: false` vale SOLO per i file privati (l'SDK
  // aggiunge `cache=0` e legge dall'origine, così un manifest aggiornato vale alla ricostruzione
  // successiva dell'indice); un manifest pubblico passa comunque dal CDN di Vercel Blob e una
  // modifica può arrivare più tardi: per questo la guida chiede di caricarlo come privato.
  const result = await get(encodeBlobPathname(file.pathname), {
    access: isPublicBlobUrl(file.url) ? 'public' : 'private',
    token,
    useCache: false,
    abortSignal: abortAfter(deadlineMs),
  });
  if (!result) return { status: 'missing' };
  if (result.statusCode !== 200 || !result.stream) return { status: 'unavailable' };
  const declaredLength = Number(result.headers.get('content-length') ?? '0');
  if (declaredLength > RIGHTS_MANIFEST_MAX_BYTES) {
    await result.stream.cancel().catch(() => undefined);
    return { status: 'oversize' };
  }
  const bytes = await readUpTo(result.stream, RIGHTS_MANIFEST_MAX_BYTES + 1);
  if (bytes.length > RIGHTS_MANIFEST_MAX_BYTES) return { status: 'oversize' };
  try {
    return { status: 'text', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { status: 'invalid', cause: 'utf8' };
  }
}

/**
 * Scarica il testo di diritti.json entro la scadenza: file null → 'missing', oltre 256 KB già
 * dall'elenco → 'oversize' (non si scarica nemmeno), errore di rete o scadenza → 'unavailable'.
 * Mai throw. Usata dalla lettura vera (readRightsManifest) e dalla diagnosi dell'amministratore.
 */
async function readManifestText(
  token: string,
  file: HomeStoreFile | null,
  deadlineMs: number,
): Promise<ManifestTextRead> {
  if (!file) return { status: 'missing' };
  if (file.size > RIGHTS_MANIFEST_MAX_BYTES) return { status: 'oversize' };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ManifestTextRead>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'unavailable' }), deadlineMs);
  });
  const work = fetchManifestText(token, file, deadlineMs).catch(
    (): ManifestTextRead => ({ status: 'unavailable' }),
  );
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Legge e valida diritti.json con il token dello store (anche se il file è privato), entro una
 * scadenza breve. `file` è l'oggetto trovato nell'elenco dello store (null = non caricato). Non fa
 * mai throw: errore di rete o scadenza → 'unavailable'. Chi chiama (featured-search.server) tiene
 * il risultato in cache finché non cambia la versione del catalogo (al più ~5 minuti), ~1 minuto
 * dopo un errore di lettura.
 */
export async function readRightsManifest(
  token: string,
  file: HomeStoreFile | null,
  deadlineMs = MANIFEST_DEADLINE_MS,
): Promise<RightsManifestRead> {
  const read = await readManifestText(token, file, deadlineMs);
  if (read.status === 'invalid') return { status: 'invalid' };
  if (read.status !== 'text') return { status: read.status };
  const parsed = parseRightsManifest(read.text);
  return parsed.ok
    ? { status: 'ok', entries: parsed.entries, skipped: parsed.skipped }
    : { status: 'invalid' };
}

// ─── Diagnosi per l'amministratore (pagina /admin/diritti-testi) ────────────────────────────────
// Stessi schemi e stesse regole del parser vero (parseManifestStructure, collectRightsEntries,
// declaredTrackEntries, readManifestText): la diagnosi non decide nulla da sola, SPIEGA in italiano
// perché il parser ha scartato o ignorato una voce. Il risultato `declared` è identico a quello
// che la ricerca calcola sullo stesso elenco. Nessun testo dei brani passa di qui.

/** Caratteri massimi del valore "file" riportato in una voce con problemi. */
export const DIAGNOSIS_FILE_MAX_CHARS = 300;
/** Motivi al massimo per voce (un oggetto con centinaia di campi in più non gonfia la risposta). */
const DIAGNOSIS_MAX_REASONS = 8;
/** Caratteri massimi di un nome di campo o di una licenza ripetuti in un motivo. */
const DIAGNOSIS_NAME_MAX_CHARS = 40;
const USER_UPLOAD_PREFIX = 'public-uploads/';

export type RightsManifestStatus = 'missing' | 'invalid' | 'valid' | 'unavailable';

export type RightsEntryProblem = {
  /** Posizione della voce in "brani", da 1. */
  index: number;
  /** Il valore "file" come è scritto (troncato), o null se manca o non è un testo. */
  file: string | null;
  /** invalid = scartata dal parser; ignored = valida ma senza effetto (doppione, file assente). */
  kind: 'invalid' | 'ignored';
  /** Motivi in italiano, almeno uno. */
  reasons: string[];
};

export type RightsManifestDiagnosis = {
  status: RightsManifestStatus;
  /** Perché il manifest intero non vale (vuoto se 'valid'). */
  reasons: string[];
  /** Riga e colonna dell'errore JSON, quando il parser le indica. */
  location: { line: number; column: number } | null;
  counts: {
    /** Voci in "brani". */
    entries: number;
    /** Voci che dichiarano davvero un brano dello store. */
    valid: number;
    /** Voci scartate dal parser. */
    invalid: number;
    /** Voci valide ma senza effetto: doppioni o file non trovato. */
    ignored: number;
  };
  /** Le voci scartate o ignorate, nell'ordine del manifest. */
  problems: RightsEntryProblem[];
  /** Pathname → voce: ESATTAMENTE declaredTrackEntries(voci di parseRightsManifest, elenco). */
  declared: Map<string, RightsEntry>;
  /**
   * Pathname dichiarato → posizione (da 1) della voce senza "testo": true che spegne il testo,
   * quando un'altra voce dello stesso file dice "testo": true (le voci non sono d'accordo).
   */
  lyricsOffBy: Map<string, number>;
  /**
   * Pathname dichiarato → posizione (da 1) della voce che spegne la COPIA OFFLINE, quando la voce
   * tenuta la consentirebbe ma un doppione dello stesso file no (le voci non sono d'accordo).
   */
  offlineOffBy: Map<string, number>;
};

function emptyDiagnosis(status: RightsManifestStatus, reasons: string[]): RightsManifestDiagnosis {
  return {
    status,
    reasons,
    location: null,
    counts: { entries: 0, valid: 0, invalid: 0, ignored: 0 },
    problems: [],
    declared: new Map(),
    lyricsOffBy: new Map(),
    offlineOffBy: new Map(),
  };
}

/** Tronca a `max` unità UTF-16 (più "…") senza spezzare un carattere. */
function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  let out = '';
  for (const char of value) {
    if (out.length + char.length > max) break;
    out += char;
  }
  return `${out}…`;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/** Un nome scritto nel manifest, ripetuto in un motivo: corto e senza caratteri di controllo. */
function shownName(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    out += code < 32 || code === 127 ? '�' : char;
  }
  return clip(out, DIAGNOSIS_NAME_MAX_CHARS);
}

/** Il campo non c'è (z.literal lo segnala come invalid_literal, gli altri come invalid_type). */
function isMissing(issue: z.ZodIssue): boolean {
  if (issue.code === z.ZodIssueCode.invalid_type) return issue.received === 'undefined';
  return issue.code === z.ZodIssueCode.invalid_literal && issue.received === undefined;
}

/**
 * Caratteri che in JSON possono stare FUORI da un testo fra virgolette (spazi, struttura, numeri,
 * true/false/null): per questi la prima occorrenza non indica l'errore.
 */
const JSON_BARE_CHARACTERS = new Set(' \t\n\r{}[]:,"0123456789+-.eEtruefalsn');

/**
 * Posizione della prima occorrenza di `token` fuori dai testi fra virgolette doppie. Fino
 * all'errore il JSON è valido, quindi per un carattere che fuori dai testi non può stare (es. “ o
 * ' o T) la prima occorrenza è proprio l'errore.
 */
function firstOutsideStrings(source: string, token: string): number | null {
  let inString = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (source.startsWith(token, index)) {
      return index;
    }
  }
  return null;
}

/** Il carattere di "Unexpected token 'x'" (V8 non dà la posizione in questo caso), se c'è. */
function unexpectedToken(message: string): string | null {
  const match = /^Unexpected token '([\s\S])'/u.exec(message);
  return match?.[1] ?? null;
}

/** Posizione e riga/colonna (da 1) dell'errore di JSON.parse, più il carattere che lo causa. */
type JsonErrorDetail = {
  location: { line: number; column: number } | null;
  /** Il carattere sbagliato (es. “ o ' o T), se noto: serve a dare un consiglio preciso. */
  culprit: string | null;
};

function jsonErrorDetail(error: unknown, source: string): JsonErrorDetail {
  const message = error instanceof Error ? error.message : '';
  const match = /\bposition (\d+)/.exec(message);
  let position: number | null = match ? Number(match[1]) : null;
  if (position === null && /end of (?:JSON )?input/i.test(message)) position = source.length;
  const token = position === null ? unexpectedToken(message) : null;
  if (token !== null && !JSON_BARE_CHARACTERS.has(token)) {
    position = firstOutsideStrings(source, token);
  }
  if (position === null || !Number.isSafeInteger(position) || position > source.length) {
    return { location: null, culprit: token };
  }
  const before = source.slice(0, position);
  const at = source.codePointAt(position);
  return {
    location: { line: before.split('\n').length, column: position - before.lastIndexOf('\n') },
    culprit: token ?? (at === undefined ? null : String.fromCodePoint(at)),
  };
}

/** Consiglio per gli sbagli più comuni (virgolette tipografiche o semplici, True/False/None). */
function jsonHint(culprit: string | null): string {
  if (culprit !== null && /^[“”„‟″‘’‚‛′«»]$/u.test(culprit)) {
    return 'virgolette tipografiche (“ ” ‘ ’): usa le virgolette dritte " (scrivi il file con un editor di testo, non con le note del telefono)';
  }
  if (culprit === "'") {
    return 'virgolette semplici \': in JSON testi e nomi vanno fra virgolette doppie "';
  }
  if (culprit === 'T' || culprit === 'F' || culprit === 'N') {
    return 'true, false e null vanno scritti in minuscolo e senza virgolette';
  }
  return 'controlla virgole, virgolette e parentesi';
}

function jsonReason(error: unknown, { location, culprit }: JsonErrorDetail): string {
  const message = error instanceof Error ? error.message : '';
  if (/end of (?:JSON )?input/i.test(message)) {
    return 'JSON non valido: il file finisce prima del previsto (manca una parentesi o una virgoletta di chiusura?)';
  }
  const hint = jsonHint(culprit);
  return location
    ? `JSON non valido alla riga ${location.line}, colonna ${location.column}: ${hint}`
    : `JSON non valido: ${hint}`;
}

/** Motivi per un primo livello sbagliato (stesso RightsManifestSchema del parser). */
function manifestShapeReasons(issues: readonly z.ZodIssue[]): string[] {
  const reasons: string[] = [];
  for (const issue of issues) {
    const field = issue.path[0];
    if (issue.path.length === 0) {
      if (issue.code === z.ZodIssueCode.unrecognized_keys) {
        for (const key of issue.keys) {
          reasons.push(
            `campo sconosciuto al primo livello: ${shownName(key)} (sono ammessi solo "versione" e "brani")`,
          );
        }
      } else {
        reasons.push('il manifest deve essere un oggetto JSON: { "versione": 1, "brani": [ … ] }');
      }
    } else if (field === 'versione') {
      reasons.push(
        isMissing(issue)
          ? 'manca "versione": 1'
          : '"versione" sbagliata: deve essere 1 (il numero, senza virgolette)',
      );
    } else if (field === 'brani') {
      if (isMissing(issue)) reasons.push('manca "brani", l’elenco dei brani dichiarati');
      else if (issue.code === z.ZodIssueCode.too_big) {
        reasons.push(`"brani" ha più di ${MAX_ENTRIES} voci`);
      } else reasons.push('"brani" non è un elenco: deve essere [ { … }, { … } ]');
    } else {
      reasons.push('struttura del manifest non valida');
    }
  }
  return reasons.length > 0 ? [...new Set(reasons)] : ['struttura del manifest non valida'];
}

const LICENSE_LIST = RIGHTS_LICENSES.join(', ');

function licenceReason(issue: z.ZodIssue, row: unknown): string {
  if (isMissing(issue)) return 'licenza mancante';
  const value = (row as { licenza?: unknown }).licenza;
  if (typeof value !== 'string') return '"licenza" deve essere un testo, es. "propria"';
  const normalized = value.trim().toLowerCase();
  // Creative Commons non commerciali (NC): Solco vende abbonamenti Pro.
  if (/(^|[-_ ])nc($|[-_ ])/.test(normalized)) {
    return `licenza non accettata: ${shownName(value)} (uso non commerciale)`;
  }
  if ((RIGHTS_LICENSES as readonly string[]).includes(normalized)) {
    return `licenza scritta in modo diverso: usa esattamente "${normalized}" (minuscole, senza spazi)`;
  }
  return `licenza sconosciuta: ${shownName(value)} (ammesse: ${LICENSE_LIST})`;
}

/** Motivi di una voce che lo schema (RightsEntrySchema) ha rifiutato. */
function entryIssueReasons(issues: readonly z.ZodIssue[], row: unknown): string[] {
  const reasons: string[] = [];
  for (const issue of issues) {
    const field = issue.path[0];
    if (issue.path.length === 0) {
      if (issue.code === z.ZodIssueCode.unrecognized_keys) {
        for (const key of issue.keys) reasons.push(`campo sconosciuto: ${shownName(key)}`);
      } else {
        reasons.push('la voce non è un oggetto: { "file": …, "licenza": …, "titolare": … }');
      }
      continue;
    }
    switch (field) {
      case 'file':
        if (isMissing(issue)) reasons.push('"file" mancante');
        else if (issue.code === z.ZodIssueCode.too_small) reasons.push('"file" vuoto');
        else if (issue.code === z.ZodIssueCode.too_big) {
          reasons.push('"file" troppo lungo (al massimo 1024 caratteri)');
        } else reasons.push('"file" deve essere un testo: il percorso del brano nello store');
        break;
      case 'licenza':
        reasons.push(licenceReason(issue, row));
        break;
      case 'titolare':
        reasons.push('titolare mancante o troppo lungo (da 1 a 120 caratteri)');
        break;
      case 'prova':
        reasons.push(
          issue.code === z.ZodIssueCode.too_big
            ? '"prova" troppo lunga (al massimo 300 caratteri)'
            : '"prova" deve essere un testo',
        );
        break;
      case 'testo':
        reasons.push('"testo" deve essere true o false (senza virgolette)');
        break;
      case 'offline':
        reasons.push('"offline" deve essere true o false (senza virgolette)');
        break;
      case 'genere':
        reasons.push(
          `"genere" deve essere un testo da 1 a ${FEATURED_GENRE_NAME_MAX} caratteri su una riga, es. "Rap italiano"`,
        );
        break;
      default:
        reasons.push(`campo ${shownName(String(field))} non valido`);
    }
  }
  return reasons;
}

/** Perché isHomeAudioBlob rifiuta un "file" altrimenti valido (la decisione resta sua). */
function pathReason(file: string): string {
  if (!isSafeBlobPathname(file)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(file)) {
      return 'percorso non valido: scrivi il percorso del file nello store, non un indirizzo web';
    }
    if (file.startsWith('/')) return 'percorso non valido: togli la "/" iniziale';
    if (file.includes('\\')) return 'percorso non valido: fra le cartelle va "/", non "\\"';
    if (hasControlCharacter(file)) return 'percorso non valido: contiene caratteri di controllo';
    const segments = file.split('/');
    if (segments.some((segment) => segment === '..' || segment === '.')) {
      return 'percorso non valido (..): niente cartelle "." o ".."';
    }
    if (segments.includes('')) return 'percorso non valido: cartella vuota ("//" o "/" finale)';
    return 'percorso non valido';
  }
  if (file.startsWith(USER_UPLOAD_PREFIX)) {
    return 'file sotto "public-uploads/" (caricamenti degli utenti): non si dichiara qui';
  }
  return 'non è un file audio (serve un’estensione audio: .mp3, .m4a, .flac, .wav, .ogg…)';
}

/** Valore "file" della voce per la diagnosi: com'è scritto, troncato; null se non è un testo. */
function writtenFile(row: unknown): string | null {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return null;
  const file = (row as { file?: unknown }).file;
  return typeof file === 'string' ? clip(file, DIAGNOSIS_FILE_MAX_CHARS) : null;
}

function limitReasons(reasons: string[]): string[] {
  const unique = [...new Set(reasons)];
  if (unique.length === 0) return ['voce non valida'];
  if (unique.length <= DIAGNOSIS_MAX_REASONS) return unique;
  const extra = unique.length - (DIAGNOSIS_MAX_REASONS - 1);
  return [...unique.slice(0, DIAGNOSIS_MAX_REASONS - 1), `… e altri ${extra} problemi`];
}

/**
 * Diagnosi del TESTO di diritti.json rispetto ai brani dello store (`audioPathnames`, come li vede
 * la Home). Stesse regole di parseRightsManifest + declaredTrackEntries. `listingComplete` = false
 * se l'elenco dello store era parziale: "file non trovato" potrebbe non essere vero e lo si dice.
 */
export function diagnoseRightsManifestText(
  text: string,
  audioPathnames: Iterable<string>,
  listingComplete = true,
): RightsManifestDiagnosis {
  const structure = parseManifestStructure(text);
  if (!structure.ok) {
    if (structure.problem.type === 'json') {
      const detail = jsonErrorDetail(structure.problem.error, structure.problem.source);
      return {
        ...emptyDiagnosis('invalid', [jsonReason(structure.problem.error, detail)]),
        location: detail.location,
      };
    }
    return emptyDiagnosis('invalid', manifestShapeReasons(structure.problem.issues));
  }

  const verdicts: Array<{ index: number; row: unknown; verdict: EntryVerdict }> = [];
  const { entries } = collectRightsEntries(structure.brani, (index, row, verdict) => {
    verdicts.push({ index, row, verdict });
  });
  const pathnames = [...audioPathnames];
  const declared = declaredTrackEntries(entries, pathnames);
  const effective = new Set(declared.values());

  // Per spiegare una voce senza effetto: forme NFC ambigue e nomi uguali a meno delle maiuscole.
  const exact = new Set(pathnames);
  const byNormalForm = new Map<string, number>();
  const caseInsensitive = new Set<string>();
  for (const pathname of exact) {
    const key = pathname.normalize('NFC');
    byNormalForm.set(key, (byNormalForm.get(key) ?? 0) + 1);
    caseInsensitive.add(key.toLowerCase());
  }
  // Posizione di una voce tenuta → indice (da 1), se una voce di quel file diceva "testo": true e
  // la prima voce di quel file (tenuta o doppione) che NON lo dice.
  const keptIndex = new Map<number, number>();
  const anyLyrics = new Map<number, boolean>();
  const firstWithoutLyrics = new Map<number, number>();
  // Copia offline: la voce tenuta (com'è scritta) la consente? E la prima voce che non la consente.
  const keptOffline = new Map<number, boolean>();
  const firstWithoutOffline = new Map<number, number>();
  for (const { index, verdict } of verdicts) {
    if (verdict.kind === 'invalid') {
      // Una voce non valida sullo stesso file di una voce tenuta spegne testo e copia offline
      // (stessa regola del parser): conta come una voce che non li concede.
      if (verdict.position === undefined) continue;
      if (!firstWithoutLyrics.has(verdict.position)) {
        firstWithoutLyrics.set(verdict.position, index + 1);
      }
      if (!firstWithoutOffline.has(verdict.position)) {
        firstWithoutOffline.set(verdict.position, index + 1);
      }
      continue;
    }
    if (verdict.kind === 'kept') {
      keptIndex.set(verdict.position, index + 1);
      keptOffline.set(verdict.position, offlineDeclared(verdict.entry));
    }
    if (verdict.entry.testo === true) anyLyrics.set(verdict.position, true);
    else if (!firstWithoutLyrics.has(verdict.position)) {
      firstWithoutLyrics.set(verdict.position, index + 1);
    }
    if (!offlineDeclared(verdict.entry) && !firstWithoutOffline.has(verdict.position)) {
      firstWithoutOffline.set(verdict.position, index + 1);
    }
  }
  // Testo spento dal disaccordo fra le voci dello stesso file (stessa regola del parser).
  const positionOf = new Map(entries.map((entry, position) => [entry, position] as const));
  const lyricsOffBy = new Map<string, number>();
  for (const [pathname, entry] of declared) {
    const position = positionOf.get(entry);
    if (position === undefined || entry.testo === true || !anyLyrics.get(position)) continue;
    const by = firstWithoutLyrics.get(position);
    if (by !== undefined) lyricsOffBy.set(pathname, by);
  }
  // Copia offline spenta da un doppione (stessa regola del parser): la voce tenuta la consentiva.
  const offlineOffBy = new Map<string, number>();
  for (const [pathname, entry] of declared) {
    const position = positionOf.get(entry);
    if (position === undefined || offlineDeclared(entry) || !keptOffline.get(position)) continue;
    const by = firstWithoutOffline.get(position);
    if (by !== undefined) offlineOffBy.set(pathname, by);
  }

  const problems: RightsEntryProblem[] = [];
  let invalid = 0;
  let ignored = 0;
  for (const { index, row, verdict } of verdicts) {
    if (verdict.kind === 'invalid') {
      invalid += 1;
      const reasons =
        verdict.issues.length > 0
          ? entryIssueReasons(verdict.issues, row)
          : [pathReason((row as { file: string }).file)];
      // Con altri errori dello schema si spiega SUBITO anche un percorso non ammesso (stesso schema
      // del campo "file" e stessa isHomeAudioBlob del parser): la decisione non cambia.
      const file =
        typeof row === 'object' && row !== null ? (row as { file?: unknown }).file : null;
      if (
        verdict.issues.length > 0 &&
        typeof file === 'string' &&
        RightsEntrySchema.shape.file.safeParse(file).success &&
        !isHomeAudioBlob(file)
      ) {
        reasons.push(pathReason(file));
      }
      if (verdict.position !== undefined) {
        reasons.unshift(
          `nomina lo stesso file della voce n. ${keptIndex.get(verdict.position) ?? '?'}: finché non la correggi o la togli, testo e copia offline di quel file restano spenti (nel dubbio si esclude)`,
        );
      }
      problems.push({
        index: index + 1,
        file: writtenFile(row),
        kind: 'invalid',
        reasons: limitReasons(reasons),
      });
      continue;
    }
    const kept = entries[verdict.position];
    if (verdict.kind === 'duplicate') {
      ignored += 1;
      const reasons = [
        `voce duplicata (vale la prima): stesso file della voce n. ${keptIndex.get(verdict.position) ?? '?'}`,
      ];
      if (anyLyrics.get(verdict.position) && kept?.testo !== true) {
        reasons.push(
          'le voci dello stesso file non sono d’accordo su "testo": il testo resta spento (serve "testo": true in tutte)',
        );
      }
      if (keptOffline.get(verdict.position) && kept && !offlineDeclared(kept)) {
        reasons.push(
          'le voci dello stesso file non sono d’accordo sulla copia offline: resta spenta (serve il permesso in tutte)',
        );
      }
      problems.push({
        index: index + 1,
        file: writtenFile(row),
        kind: 'ignored',
        reasons: limitReasons(reasons),
      });
      continue;
    }
    if (kept && effective.has(kept)) continue;
    ignored += 1;
    const file = verdict.entry.file;
    const normal = file.normalize('NFC');
    let reason: string;
    if (!exact.has(file) && (byNormalForm.get(normal) ?? 0) > 1) {
      reason =
        'più file nello store hanno questo nome scritto con accenti in forme diverse: scrivi il percorso esatto';
    } else if (exact.has(file) || byNormalForm.has(normal)) {
      reason = 'file già coperto da un’altra voce (vale la prima)';
    } else if (caseInsensitive.has(normal.toLowerCase())) {
      reason =
        'file non trovato nello store: c’è un file con lo stesso nome ma maiuscole/minuscole diverse (il percorso deve essere identico)';
    } else {
      reason = listingComplete
        ? 'file non trovato nello store: controlla cartelle, maiuscole, spazi ed estensione'
        : 'file non trovato nello store (elenco dello store incompleto: riprova tra poco)';
    }
    problems.push({ index: index + 1, file: writtenFile(row), kind: 'ignored', reasons: [reason] });
  }

  return {
    status: 'valid',
    reasons: [],
    location: null,
    counts: { entries: structure.brani.length, valid: declared.size, invalid, ignored },
    problems,
    declared,
    lyricsOffBy,
    offlineOffBy,
  };
}

/**
 * Diagnosi di diritti.json per l'amministratore: lo legge come la ricerca (readManifestText, stesse
 * regole di dimensione e UTF-8) e lo spiega con diagnoseRightsManifestText. `file` e
 * `audioPathnames` vengono dallo STESSO elenco dello store. Mai throw.
 */
export async function diagnoseRightsManifest(
  token: string,
  file: HomeStoreFile | null,
  audioPathnames: readonly string[],
  { listingComplete = true, deadlineMs = MANIFEST_DEADLINE_MS } = {},
): Promise<RightsManifestDiagnosis> {
  // Come la ricerca: elenco interrotto prima di trovare il manifest → non si sa se c'è.
  if (!file && !listingComplete) {
    return emptyDiagnosis('unavailable', [
      'elenco dello store incompleto: non so se diritti.json c’è. Riprova tra poco.',
    ]);
  }
  const read = await readManifestText(token, file, deadlineMs);
  switch (read.status) {
    case 'text':
      return diagnoseRightsManifestText(read.text, audioPathnames, listingComplete);
    case 'missing':
      return emptyDiagnosis('missing', [
        'diritti.json non c’è nella radice dello store: nessun brano in evidenza è ricercabile',
      ]);
    case 'oversize':
      return emptyDiagnosis('invalid', [
        'diritti.json supera 256 KB: nessun brano è ricercabile finché non lo riduci',
      ]);
    case 'invalid':
      return emptyDiagnosis('invalid', [
        'diritti.json non è testo UTF-8 valido: salvalo con la codifica UTF-8',
      ]);
    default:
      return emptyDiagnosis('unavailable', [
        'non riesco a leggere diritti.json dallo store (errore o tempo scaduto): riprova tra poco',
      ]);
  }
}

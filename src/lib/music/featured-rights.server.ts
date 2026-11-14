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
//         "titolare": "Artista"
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
//         "testo": true
//       },
//       {
//         "file": "Strumentale - Pioggia.mp3",
//         "licenza": "cc-by",
//         "titolare": "Strumentale",
//         "prova": "https://creativecommons.org/licenses/by/4.0/"
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
//   brani o le copertine della Home. Una revoca ("testo" tolto o false) vale entro ~5 minuti.
// - Nessun altro campo: un campo in più rende NON valida quella voce (o tutto il manifest, se è al
//   primo livello). Una voce non valida viene ignorata da sola, le altre restano; una voce ripetuta
//   conta una volta (vale la prima), ma il testo si mostra solo se TUTTE le voci di quel file
//   hanno "testo": true.
// - Tempi (cache): una REVOCA vale nella ricerca entro ~6 minuti al massimo con il manifest privato
//   (indice fino a 5 minuti + risposte con brani in evidenza in cache al massimo 1 minuto); da
//   pubblico si aggiunge la propagazione del CDN. Un brano appena dichiarato compare di solito
//   entro ~5 minuti, fino a ~20 per una ricerca già in cache. Dettagli in featured-search.server.ts.
//
// Un brano scaricato da siti che copiano Spotify (o comunque senza licenza) NON va dichiarato.
import 'server-only';
import { get } from '@vercel/blob';
import { z } from 'zod';
import {
  encodeBlobPathname,
  type HomeStoreFile,
  isHomeAudioBlob,
  isPublicBlobUrl,
} from '@/lib/music/home-tracks.server';

/** Nome del manifest, nella radice dello store Blob. */
export const RIGHTS_MANIFEST_PATHNAME = 'diritti.json';
/** Dimensione massima del manifest: oltre, nessun brano è ricercabile. */
export const RIGHTS_MANIFEST_MAX_BYTES = 256 * 1024;
/** Tempo massimo per leggere il manifest dallo store (la ricerca non aspetta oltre). */
const MANIFEST_DEADLINE_MS = 4000;
/** Tetto alle voci (256 KB ne contengono comunque poche migliaia). */
const MAX_ENTRIES = 5000;

/** Licenze accettate. Mai le Creative Commons non commerciali (NC). */
export const RIGHTS_LICENSES = [
  'propria',
  'licenza',
  'cc0',
  'cc-by',
  'cc-by-sa',
  'cc-by-nd',
] as const;

const RightsEntrySchema = z
  .object({
    file: z.string().min(1).max(1024),
    licenza: z.enum(RIGHTS_LICENSES),
    titolare: z.string().trim().min(1).max(120),
    prova: z.string().trim().max(300).optional(),
    // Testo del brano mostrabile nel player: solo con true (assente = false, manifest vecchi validi).
    testo: z.boolean().optional(),
  })
  .strict();
export type RightsEntry = z.infer<typeof RightsEntrySchema>;

/** True solo se la voce dichiara esplicitamente i diritti sul TESTO del brano ("testo": true). */
export function lyricsDeclared(entry: Pick<RightsEntry, 'testo'>): boolean {
  return entry.testo === true;
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

/**
 * Valida il testo del manifest. Struttura sbagliata (JSON non valido, versione diversa da 1, campi
 * in più al primo livello, "brani" non è un elenco) → { ok: false }: nessun brano ricercabile.
 * Ogni voce non valida (campi mancanti o in più, licenza non ammessa, percorso non sicuro, non
 * audio o sotto public-uploads/) è scartata da sola e contata in `skipped`; i doppioni collassano.
 */
export function parseRightsManifest(text: string): RightsManifestParse {
  let raw: unknown;
  try {
    // Il BOM UTF-8 (Blocco note di Windows) non è JSON: si toglie.
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return { ok: false };
  }
  const manifest = RightsManifestSchema.safeParse(raw);
  if (!manifest.success) return { ok: false };

  // Forma NFC del file → posizione della voce tenuta in `entries`.
  const seen = new Map<string, number>();
  const entries: RightsEntry[] = [];
  let skipped = 0;
  for (const row of manifest.data.brani) {
    const parsed = RightsEntrySchema.safeParse(row);
    // Stessa regola dei brani della Home e del proxy di streaming: niente "..", percorsi assoluti,
    // barre rovesciate, caratteri di controllo, upload degli utenti o file non audio.
    if (!parsed.success || !isHomeAudioBlob(parsed.data.file)) {
      skipped += 1;
      continue;
    }
    const key = parsed.data.file.normalize('NFC');
    const keptAt = seen.get(key);
    if (keptAt !== undefined) {
      // Voce ripetuta (anche solo nella forma Unicode): conta la prima, ma il TESTO vale solo se
      // TUTTE le voci di quel file dicono "testo": true. Nel dubbio si esclude, qualunque sia
      // l'ordine: una voce aggiunta in fondo con "testo": false revoca il testo.
      const kept = entries[keptAt];
      if (kept && kept.testo === true && parsed.data.testo !== true) {
        entries[keptAt] = { ...kept, testo: false };
      }
      continue;
    }
    seen.set(key, entries.length);
    entries.push(parsed.data);
  }
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

async function fetchManifest(
  token: string,
  file: HomeStoreFile,
  deadlineMs: number,
): Promise<RightsManifestRead> {
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
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { status: 'invalid' };
  }
  const parsed = parseRightsManifest(text);
  return parsed.ok
    ? { status: 'ok', entries: parsed.entries, skipped: parsed.skipped }
    : { status: 'invalid' };
}

/**
 * Legge e valida diritti.json con il token dello store (anche se il file è privato), entro una
 * scadenza breve. `file` è l'oggetto trovato nell'elenco dello store (null = non caricato). Non fa
 * mai throw: errore di rete o scadenza → 'unavailable'. Chi chiama (featured-search.server) tiene
 * il risultato in cache: ~5 minuti se valido, ~1 minuto altrimenti.
 */
export async function readRightsManifest(
  token: string,
  file: HomeStoreFile | null,
  deadlineMs = MANIFEST_DEADLINE_MS,
): Promise<RightsManifestRead> {
  if (!file) return { status: 'missing' };
  // Già dall'elenco: troppo grande, non si scarica nemmeno.
  if (file.size > RIGHTS_MANIFEST_MAX_BYTES) return { status: 'oversize' };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<RightsManifestRead>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'unavailable' }), deadlineMs);
  });
  const work = fetchManifest(token, file, deadlineMs).catch(
    (): RightsManifestRead => ({ status: 'unavailable' }),
  );
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

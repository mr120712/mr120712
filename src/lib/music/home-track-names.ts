// @polsia:user-owned — titoli e artisti PERSONALIZZATI dei "brani in evidenza": il manifest
// `titoli.json` che l'amministratore carica nella RADICE dello store Vercel Blob (accanto ai brani,
// come diritti.json). Senza, titolo e artista vengono dal nome del file ("Artista - Titolo.mp3").
// Logica PURA (client, server e test): la lettura dallo store sta in home-track-names.server.ts.
//
// COME SCRIVERE titoli.json (testo UTF-8, JSON valido, massimo 256 KB, caricato come PRIVATO):
//
//   {
//     "versione": 1,
//     "brani": [
//       { "file": "spotifydown.com - Aura..mp3", "titolo": "Aura", "artista": "Nome artista" },
//       { "file": "Strumentale - Pioggia.mp3", "titolo": "Pioggia" },
//       { "file": "Demo 01.mp3", "artista": "" }
//     ]
//   }
//
// - "versione": sempre 1.
// - "file": il pathname ESATTO del file audio nello store (cartelle comprese, maiuscole e spazi
//   identici, con l'estensione). Una voce per un file che non c'è viene ignorata.
// - "titolo": facoltativo, da 1 a 200 caratteri, senza a capo. Sostituisce il titolo mostrato.
// - "artista": facoltativo, da 1 a 200 caratteri; "" (vuoto) o null = nessun artista mostrato.
// - Almeno uno fra "titolo" e "artista"; gli altri campi di una voce vengono ignorati (così un
//   inventario con più dati funziona lo stesso). Con due voci per lo stesso file vale la prima.
//
// NON tocca i diritti: cambia solo come un brano si CHIAMA in Home, nelle sezioni e, per i soli
// brani dichiarati in diritti.json, nella ricerca e nelle pagine artista. Un brano non dichiarato
// resta fuori dalla ricerca anche con un titolo personalizzato.
import { z } from 'zod';

export const TITLES_MANIFEST_PATHNAME = 'titoli.json';
export const TITLES_MANIFEST_MAX_BYTES = 256 * 1024;
/** Tetto alle voci (256 KB ne contengono comunque poche migliaia). */
export const TITLES_MAX_ENTRIES = 5000;
/** Stessi limiti del contratto della Home (HomeTrackSchema: title e artist al più 200). */
export const TITLE_MAX_LENGTH = 200;
export const ARTIST_MAX_LENGTH = 200;

/** Il nome personalizzato di un brano: titolo e/o artista (null = nessun artista). */
export type HomeTrackName = { title?: string; artist?: string | null };
/** Per pathname del file in forma Unicode NFC (come i confronti di diritti.json). */
export type HomeTrackNames = ReadonlyMap<string, HomeTrackName>;
export const EMPTY_HOME_TRACK_NAMES: HomeTrackNames = new Map();

// biome-ignore lint/suspicious/noControlCharactersInRegex: rifiuta proprio i caratteri di controllo.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const nameText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !CONTROL_CHARS.test(value), 'Caratteri non ammessi.');

/** Una voce di "brani": "file" obbligatorio, "titolo" e/o "artista"; altri campi ignorati. */
const EntrySchema = z
  .object({
    file: z.string().min(1).max(1024),
    titolo: nameText(TITLE_MAX_LENGTH).optional(),
    artista: z
      .union([nameText(ARTIST_MAX_LENGTH), z.literal(''), z.null()])
      .optional()
      .transform((value) => (value === '' ? null : value)),
  })
  .passthrough()
  .refine((entry) => entry.titolo !== undefined || entry.artista !== undefined, {
    message: 'Serve almeno "titolo" o "artista".',
  });

const ManifestSchema = z
  .object({ versione: z.literal(1), brani: z.array(z.unknown()).max(TITLES_MAX_ENTRIES) })
  .passthrough();

/**
 * Percorso plausibile di un file dello store: niente "/" iniziale, barre rovesciate, "..", caratteri
 * di controllo o upload degli utenti. (Il file deve poi esistere: altrimenti la voce non si applica.)
 */
export function isPlausibleStorePathname(pathname: string): boolean {
  if (pathname.startsWith('/') || pathname.includes('\\') || CONTROL_CHARS.test(pathname)) {
    return false;
  }
  if (pathname.split('/').some((segment) => segment === '' || segment === '..')) return false;
  return !pathname.startsWith('public-uploads/');
}

export type HomeTrackNamesParse =
  | { ok: true; names: HomeTrackNames; entries: number; skipped: number }
  | { ok: false; reason: 'json' | 'shape' };

/** Testo di titoli.json → nomi per file. Mai throw. */
export function parseHomeTrackNames(text: string): HomeTrackNamesParse {
  // Il BOM UTF-8 (Blocco note di Windows) non è JSON: si toglie.
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return { ok: false, reason: 'json' };
  }
  const manifest = ManifestSchema.safeParse(raw);
  if (!manifest.success) return { ok: false, reason: 'shape' };
  const names = new Map<string, HomeTrackName>();
  let skipped = 0;
  for (const row of manifest.data.brani) {
    const entry = EntrySchema.safeParse(row);
    if (!entry.success || !isPlausibleStorePathname(entry.data.file)) {
      skipped += 1;
      continue;
    }
    const key = entry.data.file.normalize('NFC');
    if (names.has(key)) {
      skipped += 1;
      continue;
    }
    const name: HomeTrackName = {};
    if (entry.data.titolo !== undefined) name.title = entry.data.titolo;
    if (entry.data.artista !== undefined) name.artist = entry.data.artista;
    names.set(key, name);
  }
  return { ok: true, names, entries: names.size, skipped };
}

/** Il nome personalizzato del brano `id` (pathname), se c'è. */
export function homeTrackNameFor(
  names: HomeTrackNames | null | undefined,
  id: string,
): HomeTrackName | null {
  if (!names || names.size === 0) return null;
  return names.get(id.normalize('NFC')) ?? null;
}

/**
 * Applica i nomi personalizzati a un elenco di brani (id = pathname): titolo e artista sostituiti
 * dove c'è una voce, tutto il resto identico. Senza nomi restituisce lo stesso elenco.
 */
export function applyHomeTrackNames<T extends { id: string; title: string; artist: string | null }>(
  tracks: readonly T[],
  names: HomeTrackNames | null | undefined,
): T[] {
  if (!names || names.size === 0) return [...tracks];
  return tracks.map((track) => {
    const name = homeTrackNameFor(names, track.id);
    if (!name) return track;
    return {
      ...track,
      title: name.title ?? track.title,
      artist: name.artist === undefined ? track.artist : name.artist,
    };
  });
}

/** Un brano come lo mostra la pagina admin: percorso esatto e nome attuale (anche già personalizzato). */
export type HomeTrackNameSource = { pathname: string; title: string; artist: string | null };

/** La voce di titoli.json per un brano, pronta da incollare: nome attuale, artista "" se manca. */
export function homeTrackNameEntry(track: HomeTrackNameSource): {
  file: string;
  titolo: string;
  artista: string;
} {
  return {
    file: track.pathname,
    titolo: track.title.slice(0, TITLE_MAX_LENGTH),
    artista: (track.artist ?? '').slice(0, ARTIST_MAX_LENGTH),
  };
}

/** Una voce in JSON su una riga (da incollare dentro "brani"). */
export function homeTrackNameEntryJson(track: HomeTrackNameSource): string {
  return JSON.stringify(homeTrackNameEntry(track));
}

/** Un titoli.json completo con una voce per ogni brano, da salvare e poi correggere a mano. */
export function homeTrackNamesManifestJson(tracks: readonly HomeTrackNameSource[]): string {
  return `${JSON.stringify(
    { versione: 1, brani: tracks.slice(0, TITLES_MAX_ENTRIES).map(homeTrackNameEntry) },
    null,
    2,
  )}\n`;
}

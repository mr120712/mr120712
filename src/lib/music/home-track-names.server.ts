// @polsia:user-owned — lettura di titoli.json (titoli e artisti personalizzati della Home) dallo
// store Vercel Blob, con il token dello store (anche se il file è privato), entro una scadenza
// breve. Stessa lettura di diritti.json (featured-rights.server: dimensione, UTF-8, scadenza). Chi
// chiama (featured-catalog.server) tiene il risultato insieme all'elenco condiviso dello store, per
// la versione del catalogo in corso. Mai throw.
import 'server-only';
import { readStoreTextFile } from '@/lib/music/featured-rights.server';
import {
  type HomeTrackNames,
  parseHomeTrackNames,
  TITLES_MANIFEST_MAX_BYTES,
} from '@/lib/music/home-track-names';
import type { HomeStoreFile } from '@/lib/music/home-tracks.server';

const NAMES_DEADLINE_MS = 4000;

export type HomeTrackNamesRead =
  | { status: 'ok'; names: HomeTrackNames; skipped: number }
  /** Nessun titoli.json nello store (stato stabile: tutti i nomi dal file). */
  | { status: 'missing' }
  /** JSON non valido, forma sbagliata o UTF-8 rotto (stato stabile: tutti i nomi dal file). */
  | { status: 'invalid' }
  /** Oltre 256 KB (stato stabile: tutti i nomi dal file). */
  | { status: 'oversize' }
  /** Errore di rete o scadenza: si riprova con l'elenco successivo. */
  | { status: 'unavailable' };

/** `file` è l'oggetto `titoli.json` trovato nell'elenco dello store (null = non caricato). */
export async function readHomeTrackNames(
  token: string,
  file: HomeStoreFile | null,
  deadlineMs = NAMES_DEADLINE_MS,
): Promise<HomeTrackNamesRead> {
  const read = await readStoreTextFile(token, file, deadlineMs, TITLES_MANIFEST_MAX_BYTES);
  if (read.status === 'invalid') return { status: 'invalid' };
  if (read.status !== 'text') return { status: read.status };
  const parsed = parseHomeTrackNames(read.text);
  return parsed.ok
    ? { status: 'ok', names: parsed.names, skipped: parsed.skipped }
    : { status: 'invalid' };
}

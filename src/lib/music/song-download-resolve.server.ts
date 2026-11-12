// @polsia:user-owned — per un brano IMPORTATO (artista + titolo, es. da una playlist Spotify o da un
// elenco) cerca su Audius una versione che l'artista ha reso SCARICABILE (is_downloadable) sotto la
// Open Music License, così quel brano può entrare in "La tua musica" offline con "scarica il permesso".
//
// Non si scarica MAI da Spotify o YouTube: si trova una registrazione lecita e scaricabile su Audius,
// quando esiste (copertura parziale: molti brani mainstream non sono su Audius). La rotta di download
// riverifica comunque la scaricabilità lato server prima di scaricare un solo byte.
import 'server-only';
import { createHash } from 'node:crypto';
import { prisma } from '@/lib/db';
import { createAudiusApiClient } from '@/lib/music/audius-api.server';
import { getAudiusActivation, runAudiusSearch } from '@/lib/music/audius-source.server';
import { normalizeMusicText, songCanonical } from '@/lib/music/background-match';
import { resolveAudiusDownload } from '@/lib/music/offline-download.server';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Una corrispondenza scaricabile vale 14 giorni (la scaricabilità su Audius può cambiare). */
export const FOUND_TTL_MS = 14 * DAY_MS;
/** "Nessuna versione scaricabile" si riprova dopo una settimana, non a ogni click. */
export const NOT_FOUND_TTL_MS = 7 * DAY_MS;
/** Quanti candidati Audius, al massimo, si verificano (ogni verifica è una chiamata getTrack). */
const MAX_CANDIDATES_CHECKED = 3;
/** Soglie del matcher (titolo quasi completo, artista almeno parziale). */
const TITLE_MIN = 0.8;
const ARTIST_MIN = 0.5;

export type DownloadResolution = { audiusTrackId: string | null };

/** Chiave di cache: hash della forma canonica (le stesse parole della ricerca). */
export function downloadResolutionKey(title: string, artist: string | null): string {
  return createHash('sha256')
    .update(`dl:${songCanonical({ title, artist }).key}`)
    .digest('hex')
    .slice(0, 40);
}

function tokenSet(value: string): Set<string> {
  return new Set(
    normalizeMusicText(value)
      .split(' ')
      .filter((word) => word.length > 1),
  );
}

/** Toglie i suffissi di versione e i "feat." per confrontare il brano vero. */
function coreTitle(title: string): string {
  const beforeDash = title.split(/\s[-–—]\s/)[0] ?? title;
  return beforeDash.replace(/\((?:feat|ft|with)\.?[^)]*\)/gi, '');
}

function mainArtist(artist: string | null): string {
  if (!artist) return '';
  return artist.split(/\s*(?:,|&|\bfeat\.?|\bft\.?|\bx\b)\s*/i)[0] ?? artist;
}

/** Sovrapposizione simmetrica di due insiemi di parole: |A∩B| / max(|A|,|B|). */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / Math.max(a.size, b.size);
}

/** Punteggio 0–1 di una traccia Audius (titolo/artista puliti) contro il brano cercato. */
export function audiusMatchScore(
  song: { title: string; artist: string | null },
  track: { title: string; artistName: string | null },
): number {
  const titleScore = overlap(tokenSet(coreTitle(song.title)), tokenSet(coreTitle(track.title)));
  const artistScore = overlap(tokenSet(mainArtist(song.artist)), tokenSet(track.artistName ?? ''));
  if (titleScore < TITLE_MIN || artistScore < ARTIST_MIN) return 0;
  return 0.5 * titleScore + 0.5 * artistScore;
}

async function peek(key: string, now: Date): Promise<DownloadResolution | null> {
  const saved = await Promise.resolve()
    .then(() => prisma.songDownloadResolution.findUnique({ where: { key } }))
    .catch(() => null);
  if (!saved || saved.expiresAt <= now) return null;
  return { audiusTrackId: saved.audiusTrackId };
}

async function write(key: string, audiusTrackId: string | null, now: Date): Promise<void> {
  const expiresAt = new Date(now.getTime() + (audiusTrackId ? FOUND_TTL_MS : NOT_FOUND_TTL_MS));
  const data = { audiusTrackId, createdAt: now, expiresAt };
  await Promise.resolve()
    .then(() =>
      prisma.songDownloadResolution.upsert({
        where: { key },
        create: { key, ...data },
        update: data,
      }),
    )
    .catch(() => undefined);
}

/**
 * La traccia Audius scaricabile per un brano importato, o { audiusTrackId: null } se non esiste.
 * Prima la cache, poi una ricerca su Audius; verifica is_downloadable solo sui candidati idonei.
 */
export async function resolveDownloadableAudiusTrack(
  title: string,
  artist: string | null,
  now = new Date(),
): Promise<DownloadResolution> {
  const key = downloadResolutionKey(title, artist);
  const cached = await peek(key, now);
  if (cached) return cached;

  const canonical = songCanonical({ title, artist });
  if (!canonical.query) return { audiusTrackId: null };

  const activation = getAudiusActivation();
  // Audius non configurato / non disponibile: non memorizzare un "niente" che non abbiamo verificato.
  if (!activation.active) return { audiusTrackId: null };

  const client = createAudiusApiClient({ apiKey: activation.apiKey });
  const search = await runAudiusSearch(canonical.query, true, client);
  if (search.outcome === 'unavailable' || search.outcome === 'inactive') {
    return { audiusTrackId: null };
  }

  // Classifica i candidati per somiglianza; verifica la scaricabilità solo sui riproducibili migliori.
  const ranked = search.tracks
    .map((track) => ({
      track,
      score: audiusMatchScore(
        { title, artist },
        { title: track.title, artistName: track.artistName },
      ),
    }))
    .filter((entry) => entry.score > 0 && entry.track.playbackEligible !== false)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES_CHECKED);

  let found: string | null = null;
  for (const entry of ranked) {
    const resolution = await resolveAudiusDownload(entry.track.id, client);
    if (resolution.ok) {
      found = entry.track.id;
      break;
    }
  }

  await write(key, found, now);
  return { audiusTrackId: found };
}

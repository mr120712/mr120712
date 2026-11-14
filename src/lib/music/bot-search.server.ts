// @polsia:user-owned — ricerca del «Bot Solco»: interroga le fonti libere e senza chiave (Audius —
// brani Creative Commons —, radio in diretta, podcast) e restituisce l'elenco misto ordinato
// (riusa rankUnifiedResults). NON interroga YouTube (niente quota) e non scarica nulla: i risultati
// sono riproducibili nel player Solco. Una fonte lenta o in errore contribuisce con zero voci.
import 'server-only';
import type { ZodType } from 'zod';
import { PodcastSchema, RadioStationSchema } from '@/lib/contracts/library';
import { AudiusTrackSearchSchema } from '@/lib/contracts/music';
import {
  UNIFIED_AUDIUS_TRACK_LIMIT,
  UNIFIED_PODCAST_LIMIT,
  UNIFIED_RADIO_LIMIT,
  type UnifiedResult,
} from '@/lib/contracts/unified-search';
import { searchMusic } from '@/lib/music/music-api.server';
import { searchPodcasts } from '@/lib/music/podcasts.server';
import { listStations } from '@/lib/music/radio-browser.server';
import { rankUnifiedResults } from '@/lib/music/unified-search';

/** Voci restituite dal bot (le fonti più sopra hanno già i loro limiti). */
const BOT_RESULT_LIMIT = 15;
const RADIO_FETCH_LIMIT = 10;

/** Tiene solo le voci conformi al contratto: una voce anomala non fa fallire la sezione. */
function validItems<T>(schema: ZodType<T>, rows: readonly unknown[]): T[] {
  return rows.flatMap((row) => {
    const parsed = schema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Esegue il lavoro, ma in caso di errore torna il valore di riserva (la sezione resta vuota). */
async function safe<T>(task: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await task();
  } catch {
    return fallback;
  }
}

export async function botSearch(query: string): Promise<UnifiedResult[]> {
  const [audius, radio, podcasts] = await Promise.all([
    safe(() => searchMusic('audius', query), null),
    safe(() => listStations({ q: query, limit: RADIO_FETCH_LIMIT }), null),
    safe(() => searchPodcasts(query), null),
  ]);

  const audiusTracks = audius
    ? validItems(AudiusTrackSearchSchema, audius.tracks).slice(0, UNIFIED_AUDIUS_TRACK_LIMIT)
    : [];
  const stations = radio
    ? validItems(RadioStationSchema, radio.stations).slice(0, UNIFIED_RADIO_LIMIT)
    : [];
  const pods = podcasts
    ? validItems(PodcastSchema, podcasts.podcasts).slice(0, UNIFIED_PODCAST_LIMIT)
    : [];

  return rankUnifiedResults({
    query,
    audiusTracks,
    youtubeVideos: [],
    stations,
    podcasts: pods,
    limit: BOT_RESULT_LIMIT,
  });
}

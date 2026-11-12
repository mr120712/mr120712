// @polsia:user-owned — "Scarica il permesso" (lato client): da una playlist Solco (o dalla Libreria)
// scarica nella libreria sul dispositivo i SOLI elementi consentiti e segnala in italiano quelli che
// restano solo in streaming.
//
// Fonti consentite: i file locali dell'ascoltatore (già sul dispositivo, nulla da scaricare), i brani
// Audius che l'artista ha reso scaricabili sotto la Open Music License, e le enclosure degli episodi
// podcast. Non si scarica MAI da YouTube, dalla radio o da Jamendo: quelli restano online con una nota.
//
// Il download vero e proprio passa SEMPRE da una rotta same-origin del server (richiede il login, è
// limitata, SSRF-safe, con tetto di 50 MB e conteggio solo a byte confermati). Qui il client chiama la
// rotta, valida l'header dei metadati con OfflineDownloadMetaSchema, e salva il Blob con addDownloadedTrack.
// I binari (come le rotte di streaming) NON passano da apiFetch, che fa res.json().

import type { MusicCollectionItem } from '@/lib/contracts/music';
import {
  OFFLINE_DOWNLOAD_META_HEADER,
  OfflineDownloadErrorSchema,
  OfflineDownloadMetaSchema,
} from '@/lib/contracts/offline';
import {
  DOWNLOADABLE_SOURCE_MAX,
  DownloadableSourceResponseSchema,
} from '@/lib/contracts/song-download';
import {
  type AddDownloadedResult,
  type DownloadedTrackInput,
  addDownloadedTrack as defaultAddDownloaded,
} from '@/lib/local-music';
import { OFFLINE_INELIGIBLE_REASONS } from '@/lib/music/offline-eligibility';

/** Nota breve mostrata sopra gli elementi che restano online. */
export const OFFLINE_ONLINE_ONLY_NOTE =
  'Resta online: i termini della fonte non ne permettono il download.';

/**
 * Evento di finestra emesso quando un brano è stato scaricato nella libreria sul dispositivo: la
 * sezione "La tua musica" lo ascolta per rileggere subito l'elenco, anche se il download è partito da
 * un'altra parte della pagina (la playlist). Nessun dato nel payload: solo un segnale di "rileggi".
 */
export const LOCAL_MUSIC_CHANGED_EVENT = 'solco:local-music-changed';

/** Segnala che la libreria sul dispositivo è cambiata (un nuovo brano scaricato). */
export function notifyLocalMusicChanged(): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  try {
    window.dispatchEvent(new Event(LOCAL_MUSIC_CHANGED_EVENT));
  } catch {
    // Un browser senza Event funzionale non blocca il download.
  }
}

/** Si iscrive all'evento di cambio libreria; torna la funzione per disiscriversi. */
export function subscribeLocalMusicChanged(listener: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return () => undefined;
  }
  window.addEventListener(LOCAL_MUSIC_CHANGED_EVENT, listener);
  return () => window.removeEventListener(LOCAL_MUSIC_CHANGED_EVENT, listener);
}

export const OFFLINE_LOGIN_REQUIRED_MESSAGE = 'Per scaricare i brani devi prima accedere.';
const OFFLINE_NETWORK_FAIL = 'Scaricamento non riuscito: controlla la connessione e riprova.';
const OFFLINE_GENERIC_FAIL = 'Scaricamento non riuscito. Riprova più tardi.';
const OFFLINE_SIZE_FAIL = 'Il brano supera il limite di 50 MB e non è stato scaricato.';
const OFFLINE_QUOTA_FAIL = 'Spazio esaurito sul dispositivo: libera spazio e riprova.';
const OFFLINE_STORE_FAIL = 'Non è stato possibile salvarlo su questo dispositivo.';

/** La rotta di download da chiamare per un elemento scaricabile. */
export type OfflineDownloadEndpoint =
  | { kind: 'audius'; trackId: string }
  | { kind: 'podcast'; podcastId: string; episodeKey: string };

/** Un elemento che si può provare a scaricare (Audius scaricabile o episodio podcast). */
export type OfflineDownloadTarget = {
  /** Id stabile per le chiavi di lista e per il focus (id dell'elemento o del brano). */
  id: string;
  title: string;
  endpoint: OfflineDownloadEndpoint;
};

/** Un elemento che resta solo in streaming, con la sua nota in italiano. */
export type OfflineOnlineOnlyItem = { id: string; title: string; reason: string };

/**
 * Un brano importato (da Spotify o da un elenco) per cui si può CERCARE una versione Audius
 * scaricabile: non ha un file scaricabile di per sé, ma potrebbe esistere una registrazione lecita.
 */
export type ResolvableSong = { id: string; title: string; artist: string | null };

/** Lo scaricabile, l'online-only e i brani importati da risolvere di una playlist/raccolta. */
export type OfflinePlan = {
  downloadable: OfflineDownloadTarget[];
  onlineOnly: OfflineOnlineOnlyItem[];
  resolvable: ResolvableSong[];
};

/** Percorso same-origin della rotta di download di un elemento. */
export function offlineDownloadPath(endpoint: OfflineDownloadEndpoint): string {
  if (endpoint.kind === 'audius') {
    return `/api/music/audius/tracks/${encodeURIComponent(endpoint.trackId)}/download`;
  }
  return `/api/music/podcasts/${encodeURIComponent(endpoint.podcastId)}/episodes/${encodeURIComponent(
    endpoint.episodeKey,
  )}/download`;
}

/**
 * Suddivide gli elementi di una raccolta in scaricabili e online-only. I brani Audius con metadati
 * completi sono "da provare": solo l'artista decide se sono scaricabili (is_downloadable) e la rotta
 * lo riverifica; un rifiuto li riporta tra gli online-only. YouTube e i brani importati restano online.
 */
export function collectionDownloadPlan(items: readonly MusicCollectionItem[]): OfflinePlan {
  const downloadable: OfflineDownloadTarget[] = [];
  const onlineOnly: OfflineOnlineOnlyItem[] = [];
  const resolvable: ResolvableSong[] = [];
  for (const item of items) {
    const title = item.title ?? 'Brano senza titolo';
    if (item.source === 'audius') {
      if (item.title && item.creatorName && item.sourceUrl) {
        downloadable.push({
          id: item.id,
          title,
          endpoint: { kind: 'audius', trackId: item.sourceId },
        });
      } else {
        onlineOnly.push({
          id: item.id,
          title,
          reason: OFFLINE_INELIGIBLE_REASONS.audiusUnavailable,
        });
      }
    } else if (item.source === 'youtube') {
      onlineOnly.push({ id: item.id, title, reason: OFFLINE_INELIGIBLE_REASONS.youtube });
    } else if (item.title && item.creatorName) {
      // Brano importato (Spotify / elenco): si prova a trovare una versione Audius scaricabile.
      resolvable.push({ id: item.id, title, artist: item.creatorName });
    } else {
      onlineOnly.push({ id: item.id, title, reason: OFFLINE_INELIGIBLE_REASONS.song });
    }
  }
  return { downloadable, onlineOnly, resolvable };
}

/** Esito della ricerca di versioni scaricabili per i brani importati. */
export type SongResolutionResult = {
  /** I brani per cui esiste una versione Audius scaricabile, pronti per il download. */
  targets: OfflineDownloadTarget[];
  /** I brani per cui non è stata trovata una versione scaricabile (restano online). */
  unresolved: ResolvableSong[];
};

/**
 * Per un gruppo di brani importati chiede al server (a lotti) se esiste una versione Audius
 * scaricabile. Non scarica nulla: restituisce i bersagli da passare poi a runOfflineDownloadBatch.
 * Non lancia mai: un errore lascia i brani tra gli "unresolved".
 */
export async function resolveDownloadableSongs(
  songs: readonly ResolvableSong[],
  deps: { fetcher?: typeof fetch } = {},
): Promise<SongResolutionResult> {
  const fetcher = deps.fetcher ?? fetch;
  const targets: OfflineDownloadTarget[] = [];
  const unresolved: ResolvableSong[] = [];
  const byId = new Map(songs.map((song) => [song.id, song]));

  for (let start = 0; start < songs.length; start += DOWNLOADABLE_SOURCE_MAX) {
    const chunk = songs.slice(start, start + DOWNLOADABLE_SOURCE_MAX);
    let response: Response;
    try {
      response = await fetcher('/api/music/import/downloadable-source', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          songs: chunk.map((song) => ({ id: song.id, title: song.title, artist: song.artist })),
        }),
      });
    } catch {
      for (const song of chunk) unresolved.push(song);
      continue;
    }
    if (!response.ok) {
      for (const song of chunk) unresolved.push(song);
      continue;
    }
    const parsed = DownloadableSourceResponseSchema.safeParse(
      await response.json().catch(() => null),
    );
    if (!parsed.success) {
      for (const song of chunk) unresolved.push(song);
      continue;
    }
    const seen = new Set<string>();
    for (const result of parsed.data.results) {
      const song = byId.get(result.id);
      if (!song) continue;
      seen.add(song.id);
      if (result.audiusTrackId) {
        targets.push({
          id: song.id,
          title: song.title,
          endpoint: { kind: 'audius', trackId: result.audiusTrackId },
        });
      } else {
        unresolved.push(song);
      }
    }
    // Brani del lotto non riportati dal server: restano tra gli unresolved.
    for (const song of chunk) if (!seen.has(song.id)) unresolved.push(song);
  }

  return { targets, unresolved };
}

/** Esito dello scaricamento di un singolo elemento. */
export type OfflineDownloadOutcome =
  | { status: 'saved'; target: OfflineDownloadTarget }
  | { status: 'already'; target: OfflineDownloadTarget }
  | { status: 'online-only'; target: OfflineDownloadTarget; reason: string }
  | { status: 'failed'; target: OfflineDownloadTarget; message: string }
  // Fermano l'intero lotto:
  | { status: 'login-required'; target: OfflineDownloadTarget; message: string }
  | { status: 'limit-reached'; target: OfflineDownloadTarget; message: string };

export type OfflineDownloadDeps = {
  fetcher?: typeof fetch;
  addDownloaded?: (input: DownloadedTrackInput) => Promise<AddDownloadedResult>;
};

function decodeMetaHeader(value: string | null): unknown {
  if (!value) throw new Error('header mancante');
  // Il server codifica i metadati come UTF-8 → base64 (così "©" e le vocali accentate restano ASCII
  // nell'header). atob torna una stringa latin1: va riletta come UTF-8, o accenti e © si corrompono.
  let json: string;
  if (typeof atob === 'function') {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    json = new TextDecoder().decode(bytes);
  } else {
    json = Buffer.from(value, 'base64').toString('utf8');
  }
  return JSON.parse(json);
}

/** Traduce una risposta di errore della rotta nell'esito del client. */
async function mapErrorResponse(
  target: OfflineDownloadTarget,
  response: Response,
): Promise<OfflineDownloadOutcome> {
  const body = await response.json().catch(() => null);
  const parsed = OfflineDownloadErrorSchema.safeParse(body);
  const message = parsed.success ? parsed.data.message : OFFLINE_GENERIC_FAIL;
  const code = parsed.success ? parsed.data.error : null;
  if (response.status === 401) {
    return { status: 'login-required', target, message: OFFLINE_LOGIN_REQUIRED_MESSAGE };
  }
  if (response.status === 429) return { status: 'limit-reached', target, message };
  if (response.status === 413) return { status: 'failed', target, message: OFFLINE_SIZE_FAIL };
  // 403 per un motivo di diritti/disponibilità (non same-origin): il brano resta solo in streaming.
  if (response.status === 403 && code !== 'forbidden_origin') {
    return { status: 'online-only', target, reason: message };
  }
  return { status: 'failed', target, message };
}

/** Mappa l'esito del salvataggio locale (quota, duplicato, troppo grande…) sull'esito del client. */
function mapAddResult(
  target: OfflineDownloadTarget,
  result: AddDownloadedResult,
): OfflineDownloadOutcome {
  if (result.ok) return { status: 'saved', target };
  switch (result.reason) {
    case 'duplicate':
      return { status: 'already', target };
    case 'too_large':
      return { status: 'failed', target, message: OFFLINE_SIZE_FAIL };
    case 'quota':
      return { status: 'failed', target, message: OFFLINE_QUOTA_FAIL };
    default:
      return { status: 'failed', target, message: OFFLINE_STORE_FAIL };
  }
}

/**
 * Scarica un elemento: chiama la rotta same-origin, valida l'header dei metadati e salva il Blob nella
 * libreria sul dispositivo. Non lancia mai: ogni errore diventa un esito leggibile.
 */
export async function downloadOne(
  target: OfflineDownloadTarget,
  deps: OfflineDownloadDeps = {},
): Promise<OfflineDownloadOutcome> {
  const fetcher = deps.fetcher ?? fetch;
  const addDownloaded = deps.addDownloaded ?? defaultAddDownloaded;

  let response: Response;
  try {
    response = await fetcher(offlineDownloadPath(target.endpoint), {
      method: 'POST',
      headers: { accept: 'application/octet-stream' },
    });
  } catch {
    return { status: 'failed', target, message: OFFLINE_NETWORK_FAIL };
  }

  if (!response.ok) return mapErrorResponse(target, response);

  let meta: ReturnType<typeof OfflineDownloadMetaSchema.parse>;
  try {
    meta = OfflineDownloadMetaSchema.parse(
      decodeMetaHeader(response.headers.get(OFFLINE_DOWNLOAD_META_HEADER)),
    );
  } catch {
    return { status: 'failed', target, message: OFFLINE_GENERIC_FAIL };
  }

  let blob: Blob;
  try {
    blob = await response.blob();
  } catch {
    return { status: 'failed', target, message: OFFLINE_NETWORK_FAIL };
  }
  if (blob.size === 0) return { status: 'failed', target, message: OFFLINE_GENERIC_FAIL };

  let result: AddDownloadedResult;
  try {
    result = await addDownloaded({
      blob,
      downloadKey: meta.downloadKey,
      source: meta.source,
      title: meta.title,
      artist: meta.artist,
      album: meta.album,
      durationSeconds: meta.durationSeconds,
      mimeType: meta.mimeType,
      attribution: meta.attribution,
    });
  } catch {
    return { status: 'failed', target, message: OFFLINE_STORE_FAIL };
  }
  return mapAddResult(target, result);
}

export type OfflineBatchProgress = { processed: number; total: number; title: string };

export type OfflineBatchResult = {
  /** Perché il lotto si è fermato prima della fine (login o limite raggiunto), o null. */
  stopped: 'login-required' | 'limit-reached' | null;
  stopMessage: string | null;
  saved: OfflineDownloadTarget[];
  already: OfflineDownloadTarget[];
  onlineOnly: Array<{ target: OfflineDownloadTarget; reason: string }>;
  failed: Array<{ target: OfflineDownloadTarget; message: string }>;
};

/**
 * Scarica gli elementi uno alla volta (file grandi, avanzamento leggibile "n di m"). Si ferma subito
 * se serve il login o se il limite giornaliero è stato raggiunto: nessun altro byte viene chiesto.
 */
export async function runOfflineDownloadBatch(
  targets: readonly OfflineDownloadTarget[],
  deps: OfflineDownloadDeps & { onProgress?: (progress: OfflineBatchProgress) => void } = {},
): Promise<OfflineBatchResult> {
  const result: OfflineBatchResult = {
    stopped: null,
    stopMessage: null,
    saved: [],
    already: [],
    onlineOnly: [],
    failed: [],
  };
  const total = targets.length;
  for (let index = 0; index < total; index += 1) {
    const target = targets[index] as OfflineDownloadTarget;
    deps.onProgress?.({ processed: index + 1, total, title: target.title });
    const outcome = await downloadOne(target, deps);
    if (outcome.status === 'login-required' || outcome.status === 'limit-reached') {
      result.stopped = outcome.status;
      result.stopMessage = outcome.message;
      break;
    }
    if (outcome.status === 'saved') result.saved.push(target);
    else if (outcome.status === 'already') result.already.push(target);
    else if (outcome.status === 'online-only')
      result.onlineOnly.push({ target, reason: outcome.reason });
    else result.failed.push({ target, message: outcome.message });
  }
  return result;
}

/** Numero di brani finiti nella libreria (nuovi + già presenti): quanti sono ora disponibili offline. */
export function offlineSavedCount(result: OfflineBatchResult): number {
  return result.saved.length + result.already.length;
}

/** Riepilogo in italiano dopo un lotto, per il toast e la nota a schermo. */
export function offlineBatchSummary(result: OfflineBatchResult): {
  tone: 'success' | 'error';
  message: string;
} {
  if (result.stopped === 'login-required') {
    return { tone: 'error', message: OFFLINE_LOGIN_REQUIRED_MESSAGE };
  }
  if (result.stopped === 'limit-reached') {
    return { tone: 'error', message: result.stopMessage ?? OFFLINE_GENERIC_FAIL };
  }
  const added = result.saved.length;
  const already = result.already.length;
  const failed = result.failed.length;
  const onlineOnly = result.onlineOnly.length;
  const parts: string[] = [];
  if (added > 0) parts.push(added === 1 ? '1 brano scaricato' : `${added} brani scaricati`);
  if (already > 0) parts.push(already === 1 ? '1 già presente' : `${already} già presenti`);
  if (failed > 0) parts.push(failed === 1 ? '1 non riuscito' : `${failed} non riusciti`);
  // Gli elementi che il server ha riportato tra i soli-streaming (es. un Audius che l'artista non
  // ha reso scaricabile) entrano nel riepilogo, così la somma torna con quanti ne erano stati
  // proposti e nessun brano sparisce in silenzio dal conteggio del pulsante.
  if (onlineOnly > 0) {
    parts.push(
      onlineOnly === 1 ? '1 resta solo in streaming' : `${onlineOnly} restano solo in streaming`,
    );
  }
  if (parts.length === 0) {
    return { tone: 'error', message: 'Nessun brano scaricato.' };
  }
  return { tone: added > 0 || already > 0 ? 'success' : 'error', message: `${parts.join(' · ')}.` };
}

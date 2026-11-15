// @polsia:user-owned — "Scarica il permesso" (lato client): da una playlist Solco (o dalla Libreria)
// scarica nella libreria sul dispositivo i SOLI elementi consentiti e segnala in italiano quelli che
// restano solo in streaming.
//
// Fonti consentite: i file locali dell'ascoltatore (già sul dispositivo, nulla da scaricare), i brani
// Audius che l'artista ha reso scaricabili sotto la Open Music License, le enclosure degli episodi
// podcast e i brani in evidenza DICHIARATI in diritti.json con il permesso della copia offline
// (`offline` true nelle risposte del server, ricontrollato dalla rotta a ogni download). Non si
// scarica MAI da YouTube, dalla radio o da Jamendo: quelli restano online con una nota.
//
// Una copia di un brano in evidenza si salva nella libreria sul dispositivo con la sua fonte
// ('featured-download'), la sua chiave ('featured:<shareId>') e la sua attribuzione: è il record in
// IndexedDB a dire che cos'è, e da lì la verifica dei permessi la ritrova e la può revocare. Si
// registra anche in featured-offline-copies (localStorage), che resta la copia veloce per le letture
// sincrone dell'interfaccia: se quel registro non è scrivibile la copia non si salva (fail closed).
//
// Il download vero e proprio passa SEMPRE da una rotta same-origin del server (richiede il login, è
// limitata, SSRF-safe, con tetto di 50 MB e conteggio solo a byte confermati). Qui il client chiama la
// rotta, valida l'header dei metadati con OfflineDownloadMetaSchema, e salva il Blob con addDownloadedTrack.
// I binari (come le rotte di streaming) NON passano da apiFetch, che fa res.json().

import {
  type CopyStorage,
  canRememberFeaturedCopies,
  FEATURED_OFFLINE_SOURCE,
  forgetEmptyDiskLook,
  forgetFeaturedCopies,
  readFeaturedCopies,
  rememberFeaturedCopy,
} from '@/components/custom/music/featured-offline-copies';
import type { HomeTrack } from '@/lib/contracts/home-tracks';
import type { MusicCollectionItem } from '@/lib/contracts/music';
import {
  FEATURED_DOWNLOAD_KEY_PREFIX,
  OFFLINE_DOWNLOAD_META_HEADER,
  OfflineDownloadErrorSchema,
  type OfflineDownloadMeta,
  OfflineDownloadMetaSchema,
  type OfflineDownloadSource,
} from '@/lib/contracts/offline';
import {
  DOWNLOADABLE_SOURCE_MAX,
  DownloadableSourceResponseSchema,
} from '@/lib/contracts/song-download';
import {
  type AddDownloadedResult,
  type DownloadedTrackInput,
  addDownloadedTrack as defaultAddDownloaded,
  getTrack as defaultGetTrack,
  listTracks as defaultListTracks,
  removeTrack as defaultRemoveTrack,
  type LocalTrack,
} from '@/lib/local-music';
// Dal modulo puro, non dall'indice: solo la lettura di fonte e attribuzione, niente IndexedDB.
import { localTrackAttribution, localTrackSource } from '@/lib/local-music/types';
import { FEATURED_SHARE_API_PREFIX, isFeaturedShareId } from '@/lib/music/featured-share';
import { OFFLINE_INELIGIBLE_REASONS, offlineEligibility } from '@/lib/music/offline-eligibility';

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
  | { kind: 'podcast'; podcastId: string; episodeKey: string }
  /** Brano in evidenza dichiarato: l'id opaco del link diretto (mai il percorso nello store). */
  | { kind: 'featured'; shareId: string };

/** La fonte delle copie dei brani in evidenza nell'header della rotta. */
const FEATURED_META_SOURCE: OfflineDownloadSource = 'featured-download';

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
  if (endpoint.kind === 'featured') {
    return `${FEATURED_SHARE_API_PREFIX}${encodeURIComponent(endpoint.shareId)}/download`;
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

/**
 * Il bersaglio «Scarica offline» di un brano in evidenza, SOLO se il server ha detto che la sua
 * voce di diritti.json consente la copia offline (`offline` true) e il brano ha il suo id opaco;
 * null altrimenti (nessun pulsante).
 */
export function featuredDownloadTarget(
  track: Pick<HomeTrack, 'id' | 'title' | 'shareId' | 'offline'>,
): OfflineDownloadTarget | null {
  if (track.offline !== true || !track.shareId || !isFeaturedShareId(track.shareId)) return null;
  return {
    id: track.id,
    title: track.title,
    endpoint: { kind: 'featured', shareId: track.shareId },
  };
}

/**
 * Divide i brani in evidenza di una pagina (cartella, artista) in scaricabili (copia offline
 * consentita) e solo-streaming, con il motivo in italiano. Nessun brano non dichiarato arriva qui
 * (il server non li manda in queste pagine); un brano senza permesso o senza id resta online.
 */
export function featuredDownloadPlan(
  tracks: readonly Pick<HomeTrack, 'id' | 'title' | 'shareId' | 'offline'>[],
): OfflinePlan {
  const downloadable: OfflineDownloadTarget[] = [];
  const onlineOnly: OfflineOnlineOnlyItem[] = [];
  for (const track of tracks) {
    const target = featuredDownloadTarget(track);
    if (target) {
      downloadable.push(target);
      continue;
    }
    const eligibility = offlineEligibility({
      source: 'featured-track',
      // Con il permesso ma senza id (condivisione spenta): non si può scaricare.
      offline: track.offline === true ? null : track.offline,
    });
    onlineOnly.push({
      id: track.id,
      title: track.title,
      reason:
        eligibility.kind === 'online-only'
          ? eligibility.reason
          : OFFLINE_INELIGIBLE_REASONS.featuredUnavailable,
    });
  }
  return { downloadable, onlineOnly, resolvable: [] };
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
  /** Toglie dal dispositivo una copia che non si è potuta registrare (solo brani in evidenza). */
  removeDownloaded?: (id: string) => Promise<void>;
  /** Il registro delle copie dei brani in evidenza (localStorage; uno finto nei test). */
  copyStorage?: CopyStorage | null;
  /** Legge un brano della libreria sul dispositivo (per sapere se una copia c'è ancora). */
  getLocalTrack?: (id: string) => Promise<LocalTrack | null>;
  /**
   * Elenca la libreria sul dispositivo (soli metadati): al tocco di «Scarica offline», per trovare
   * una copia che c'è già ma di cui il registro ha perso la voce.
   */
  listLocalTracks?: () => Promise<LocalTrack[]>;
};

/**
 * True se su questo dispositivo c'è GIÀ la copia offline del brano in evidenza `shareId`: voce nel
 * registro e file ancora nella libreria. Una voce il cui file non c'è più si dimentica (si potrà
 * riscaricare). Nessuna rete; mai throw (nel dubbio false: si riscarica, il server decide). Legge
 * solo il registro, perché la chiama ogni pulsante «Scarica offline» della pagina: se il registro
 * ha perso la voce ma la copia è ancora nella libreria lo scopre downloadOne, al tocco
 * (restoreFeaturedCopyEntry), e comunque la verifica delle copie ricostruisce la voce dal disco.
 */
export async function featuredCopySaved(
  shareId: string,
  deps: Pick<OfflineDownloadDeps, 'copyStorage' | 'getLocalTrack'> = {},
): Promise<boolean> {
  const copies = readFeaturedCopies(deps.copyStorage).filter((copy) => copy.featuredId === shareId);
  if (copies.length === 0) return false;
  const readTrack = deps.getLocalTrack ?? defaultGetTrack;
  const gone: string[] = [];
  for (const copy of copies) {
    let track: LocalTrack | null;
    try {
      track = await readTrack(copy.localId);
    } catch {
      // Libreria illeggibile adesso: non si dimentica nulla.
      return false;
    }
    if (track?.id === copy.localId) return true;
    gone.push(copy.localId);
  }
  forgetFeaturedCopies(gone, deps.copyStorage);
  return false;
}

/**
 * Cerca NELLA LIBRERIA sul dispositivo (la fonte di verità) la copia offline del brano in evidenza
 * `shareId` di cui il registro non ha la voce: se c'è, ricostruisce la voce (id dalla chiave del
 * download, attribuzione e data dal record) e torna true. Senza questo il tocco chiederebbe di
 * nuovo il file al server (un download contato, fino a 50 MB) solo per scoprire che è un duplicato,
 * e il pulsante tornerebbe a «Scarica». Una lettura dei soli metadati, al tocco. Mai throw:
 * libreria illeggibile → false (si chiede al server, come prima). La copia ritrovata non salta
 * nessun controllo: la voce ricostruita fa partire la verifica dei permessi, che la toglie se è
 * stata revocata.
 */
async function restoreFeaturedCopyEntry(
  shareId: string,
  deps: Pick<OfflineDownloadDeps, 'copyStorage' | 'listLocalTracks'>,
): Promise<boolean> {
  let tracks: LocalTrack[];
  try {
    tracks = await (deps.listLocalTracks ?? defaultListTracks)();
  } catch {
    return false;
  }
  const downloadKey = `${FEATURED_DOWNLOAD_KEY_PREFIX}${shareId}`;
  // Solo un record che la libreria riconosce come copia di QUESTO brano: mai un file
  // dell'ascoltatore, qualunque nome abbia (la chiave del download la portano solo i download).
  const track = tracks.find(
    (item) =>
      localTrackSource(item) === FEATURED_OFFLINE_SOURCE && item.downloadKey === downloadKey,
  );
  if (!track) return false;
  rememberFeaturedCopy(
    {
      localId: track.id,
      featuredId: shareId,
      attribution: localTrackAttribution(track),
      savedAt: track.addedAt,
    },
    deps.copyStorage,
  );
  return true;
}

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
  const featured = target.endpoint.kind === 'featured';
  const copyStorage = deps.copyStorage;
  // Una copia di un brano in evidenza deve restare revocabile: senza registro scrivibile non si
  // chiede nemmeno il file (e non si consuma un download del giorno).
  if (featured && !canRememberFeaturedCopies(copyStorage)) {
    return { status: 'failed', target, message: OFFLINE_STORE_FAIL };
  }
  // Copia già sul dispositivo: nessuna richiesta (non si consuma un download del giorno né si
  // ritrasferisce il file). La verifica dei permessi la toglie se viene revocata. Lo dice il
  // registro e, se ha perso la voce, la libreria stessa.
  if (
    target.endpoint.kind === 'featured' &&
    ((await featuredCopySaved(target.endpoint.shareId, deps)) ||
      (await restoreFeaturedCopyEntry(target.endpoint.shareId, deps)))
  ) {
    return { status: 'already', target };
  }

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

  let meta: OfflineDownloadMeta;
  try {
    meta = OfflineDownloadMetaSchema.parse(
      decodeMetaHeader(response.headers.get(OFFLINE_DOWNLOAD_META_HEADER)),
    );
  } catch {
    return { status: 'failed', target, message: OFFLINE_GENERIC_FAIL };
  }
  // Una copia di un brano in evidenza si salva SOLO dalla sua rotta, con la sua chiave (e quindi
  // sempre registrata per la revoca); nessun'altra rotta può salvare una copia "in evidenza".
  const featuredMeta = meta.source === FEATURED_META_SOURCE;
  if (
    featured !== featuredMeta ||
    (target.endpoint.kind === 'featured' &&
      meta.downloadKey !== `${FEATURED_DOWNLOAD_KEY_PREFIX}${target.endpoint.shareId}`)
  ) {
    void response.body?.cancel().catch(() => undefined);
    return { status: 'failed', target, message: OFFLINE_GENERIC_FAIL };
  }

  let blob: Blob;
  try {
    blob = await response.blob();
  } catch {
    return { status: 'failed', target, message: OFFLINE_NETWORK_FAIL };
  }
  if (blob.size === 0) return { status: 'failed', target, message: OFFLINE_GENERIC_FAIL };

  // Sta per esserci una copia sul dispositivo: il promemoria «sul disco non c'è nessuna copia»
  // (featured-offline-sync-mount) si toglie PRIMA di salvare, non dopo.
  if (featured) forgetEmptyDiskLook(copyStorage);

  let result: AddDownloadedResult;
  try {
    result = await addDownloaded({
      blob,
      downloadKey: meta.downloadKey,
      // La fonte resta nel record della libreria (per una copia di un brano in evidenza:
      // 'featured-download' con la chiave 'featured:<shareId>'), che è la fonte di verità.
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
  if (featured && target.endpoint.kind === 'featured' && result.ok) {
    const remembered = rememberFeaturedCopy(
      {
        localId: result.track.id,
        featuredId: target.endpoint.shareId,
        attribution: meta.attribution,
        savedAt: Date.now(),
      },
      copyStorage,
    );
    if (!remembered) {
      // Non revocabile = non si tiene: la copia appena salvata si toglie dal dispositivo.
      await (deps.removeDownloaded ?? defaultRemoveTrack)(result.track.id).catch(() => undefined);
      return { status: 'failed', target, message: OFFLINE_STORE_FAIL };
    }
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

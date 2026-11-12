// @polsia:user-owned — "La tua musica" in Libreria: i file audio dell'ascoltatore, salvati solo su
// questo dispositivo e suonati dal player condiviso, anche offline.
//
// Design legale: qui non c'è rete. Niente apiFetch, fetch o analytics: aggiunta, elenco, copertine,
// rimozione e riproduzione passano solo da '@/lib/local-music' (IndexedDB e object URL del browser)
// e dal player (playbackMode 'local': nessun permesso, contatore Free, login, cronologia, premi,
// playlist o Preferiti). È l'unica sezione della Libreria che deve funzionare del tutto offline.
//
// Le copertine sono object URL creati qui solo per le righe vicine allo schermo (al massimo
// MAX_LIVE_COVERS insieme), revocati quando il brano sparisce dall'elenco, quando escono dalla
// cache e allo smontaggio; il player crea e revoca i propri. Si vedono le prime
// INITIAL_VISIBLE_ROWS righe, le altre con "Mostra tutti". L'aggiunta in corso vive a livello di
// modulo: tornando in Libreria a metà importazione l'avanzamento resta e l'elenco si aggiorna.
// Il controllo del supporto avviene dopo il montaggio (sul server IndexedDB non esiste): l'HTML
// iniziale mostra solo titolo, spiegazione e attesa.
'use client';

import {
  AudioLines,
  EllipsisVertical,
  Info,
  Music,
  Pause,
  Play,
  Plus,
  Shuffle,
  Trash2,
} from 'lucide-react';
import {
  type ChangeEvent,
  type MouseEvent,
  memo,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { toast } from 'sonner';
import { localTrackToPlayerTrack } from '@/components/custom/music/local-tracks';
import { useOptionalMusicPlayer } from '@/components/custom/music/music-player';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Progress } from '@/components/ui/progress';
import {
  type AddFilesResult,
  addFiles,
  clearAll,
  createObjectUrlForArtwork,
  isLocalMusicSupported,
  LocalMusicUnavailableError,
  type LocalMusicUsage,
  type LocalSkipReason,
  type LocalTrack,
  listTracks,
  MAX_LOCAL_FILE_BYTES,
  type ObjectUrlHandle,
  type PersistenceResult,
  removeTrack,
  requestPersistence,
  usage,
} from '@/lib/local-music';
import { artInitial } from '@/lib/music/art-initial';
import styles from './local-music-section.module.css';

export const LOCAL_MUSIC_SECTION_ID = 'la-tua-musica';

/** Tipi che il selettore propone (anche per estensione: iOS non sempre dichiara il tipo). */
export const LOCAL_MUSIC_ACCEPT = 'audio/*,.mp3,.m4a,.aac,.wav,.flac,.ogg';

export const LOCAL_MUSIC_PRIVACY_LINE =
  'I brani che aggiungi restano solo su questo dispositivo: non vengono caricati su Solco e funzionano anche offline.';

export const LOCAL_MUSIC_UNSUPPORTED_MESSAGE =
  'Questo browser non permette di salvare brani sul dispositivo.';

/**
 * Su iOS lo spazio dell'app sulla schermata Home è separato da quello di Safari: i brani vanno
 * aggiunti dall'icona, non prima in Safari (lì WebKit può cancellarli dopo qualche giorno).
 */
export const HOME_SCREEN_HINT =
  "Su iPhone e iPad, Safari può cancellare i brani se non apri Solco per qualche giorno. Per tenerli, aggiungi Solco alla schermata Home (Condividi → Aggiungi alla schermata Home) e aggiungi i brani dall'icona di Solco: lì lo spazio è separato da Safari.";

export const IOS_FILES_HINT =
  "Su iPhone e iPad scegli i file dall'app File (i brani di Apple Music non si possono aggiungere).";

export const LOCAL_MUSIC_READ_ERROR = 'Non riesco a leggere i brani salvati su questo dispositivo.';

/** Righe mostrate prima di "Mostra tutti": una libreria grande non spinge giù il resto della pagina. */
export const INITIAL_VISIBLE_ROWS = 20;
/** Copertine (object URL) vive insieme al massimo: le meno recenti fuori schermo si revocano. */
export const MAX_LIVE_COVERS = 60;

const MIB = 1024 * 1024;
/** Quanti file saltati si nominano nel riepilogo; gli altri si contano. */
const MAX_LISTED_SKIPS = 4;
/** Copertine lette da IndexedDB in parallelo (una libreria grande non apre centinaia di letture). */
const COVER_BATCH = 6;
/** Una riga è "vicina" allo schermo entro un'altezza di schermo sopra o sotto. */
const COVER_ROOT_MARGIN = '100% 0px';
/** La regione aria-live dice l'avanzamento all'inizio, ogni 10 file o 5 secondi, e alla fine. */
const ANNOUNCE_EVERY_FILES = 10;
const ANNOUNCE_EVERY_MS = 5000;
/** Durante un'aggiunta lunga l'elenco si rilegge ogni 5 file, così i brani compaiono man mano. */
const REFRESH_EVERY_FILES = 5;

export const SKIP_REASON_LABELS: Record<LocalSkipReason, string> = {
  unsupported: 'formato non supportato',
  too_large: `troppo grande (oltre ${Math.round(MAX_LOCAL_FILE_BYTES / MIB)} MB)`,
  duplicate: 'già presente',
  quota: 'spazio esaurito',
  error: 'errore',
};

function countLabel(count: number): string {
  return count === 1 ? '1 brano' : `${count} brani`;
}

export type ImportSummary = {
  tone: 'success' | 'error';
  title: string;
  description: string | null;
};

/** Testo del toast di fine importazione: quanti brani aggiunti e, con il motivo, quali saltati. */
export function importSummary(result: AddFilesResult): ImportSummary {
  const added = result.added.length;
  const title =
    added === 0
      ? 'Nessun brano aggiunto'
      : added === 1
        ? '1 brano aggiunto'
        : `${added} brani aggiunti`;
  let description: string | null = null;
  const skipped = result.skipped;
  if (skipped.length > 0) {
    const listed = skipped
      .slice(0, MAX_LISTED_SKIPS)
      .map(
        (file) => `${file.name} (${SKIP_REASON_LABELS[file.reason] ?? SKIP_REASON_LABELS.error})`,
      );
    const others = skipped.length - listed.length;
    description = `${skipped.length === 1 ? 'Non aggiunto' : 'Non aggiunti'}: ${listed.join(', ')}${
      others > 0 ? ` e altri ${others}` : ''
    }.`;
    if (skipped.some((file) => file.reason === 'quota')) {
      description += ' Libera spazio sul dispositivo e riprova.';
    }
  }
  return { tone: added > 0 ? 'success' : 'error', title, description };
}

/** Durata come nel player: m:ss (h:mm:ss oltre l'ora), null se ignota. */
export function formatTrackDuration(seconds: number | null | undefined): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  const value = Math.floor(seconds);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const rest = String(value % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

function decimal(value: number): string {
  return value.toLocaleString('it-IT', { maximumFractionDigits: 1 });
}

/** Spazio occupato in unità leggibili (MB come il limite di 200 MB: 1 MB = 1024 × 1024 byte). */
export function formatBytes(bytes: number): string {
  const value = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (value === 0) return '0 MB';
  if (value >= 1024 * MIB) return `${decimal(value / (1024 * MIB))} GB`;
  if (value >= 10 * MIB) return `${Math.round(value / MIB)} MB`;
  if (value >= MIB / 10) return `${decimal(value / MIB)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

/** "12 brani · 48 MB su questo dispositivo". */
export function usageLine(tracks: number, bytes: number): string {
  return `${countLabel(tracks)} · ${formatBytes(bytes)} su questo dispositivo`;
}

export type DeviceEnv = {
  userAgent: string;
  maxTouchPoints?: number;
  /** navigator.standalone di iOS: true nell'app aggiunta alla schermata Home. */
  standalone?: boolean;
  /** (display-mode: standalone). */
  displayModeStandalone?: boolean;
};

/** iPhone, iPad o iPod (iPadOS si presenta come Mac: conta il touch). */
export function isIosDevice(env: DeviceEnv): boolean {
  return (
    /iPhone|iPad|iPod/i.test(env.userAgent) ||
    (/Macintosh/.test(env.userAgent) && (env.maxTouchPoints ?? 0) > 1)
  );
}

/**
 * iPhone/iPad in una scheda del browser (non dalla schermata Home): lì WebKit può cancellare i dati
 * di un sito non usato per 7 giorni, brani compresi.
 */
export function isIosBrowserTab(env: DeviceEnv): boolean {
  return isIosDevice(env) && env.standalone !== true && env.displayModeStandalone !== true;
}

function currentDeviceEnv(): DeviceEnv | null {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return null;
  let displayModeStandalone = false;
  try {
    displayModeStandalone =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(display-mode: standalone)').matches;
  } catch {
    displayModeStandalone = false;
  }
  return {
    userAgent: typeof navigator.userAgent === 'string' ? navigator.userAgent : '',
    maxTouchPoints: navigator.maxTouchPoints,
    standalone: (navigator as Navigator & { standalone?: boolean }).standalone,
    displayModeStandalone,
  };
}

/** Copia mescolata (Fisher–Yates). */
export function shuffledCopy<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const pick = Math.min(index, Math.floor(random() * (index + 1)));
    [copy[index], copy[pick]] = [copy[pick] as T, copy[index] as T];
  }
  return copy;
}

function isUnavailable(error: unknown): boolean {
  return (
    error instanceof LocalMusicUnavailableError ||
    (error instanceof Error && error.name === 'LocalMusicUnavailableError')
  );
}

function qualifiedIdOf(track: Pick<LocalTrack, 'id'>): string {
  return `local:${track.id}`;
}

type Phase = 'checking' | 'unsupported' | 'loading' | 'ready' | 'error';
type ImportProgress = { processed: number; total: number };
/** Dopo una rimozione o "Mostra tutti": la riga da mettere a fuoco, o "Aggiungi brani". */
type FocusTarget = number | 'add';
type Device = { ios: boolean; iosTab: boolean };

// --- Aggiunta in corso, a livello di modulo -------------------------------------------------
// Un'aggiunta di molti file dura un po': se l'ascoltatore lascia la Libreria e ci torna, la
// sezione montata di nuovo vede lo stesso avanzamento, non ne avvia una seconda e rilegge l'elenco
// alla fine. Toast e riepilogo partono una volta sola, anche se nessuna sezione è montata.

type ImportSnapshot = {
  progress: ImportProgress | null;
  /** Testo della regione aria-live: aggiornato all'inizio, ogni ~10 file o 5 s, e alla fine. */
  announcement: string;
  /** Aggiunte concluse finora: una sezione montata rilegge l'elenco quando cambia. */
  finished: number;
  /** Brani aggiunti dall'ultima aggiunta conclusa. */
  lastAdded: number;
};

let importSnapshot: ImportSnapshot = {
  progress: null,
  announcement: '',
  finished: 0,
  lastAdded: 0,
};
const importListeners = new Set<() => void>();
let lastAnnounced = { processed: -1, at: 0 };

function setImportSnapshot(patch: Partial<ImportSnapshot>) {
  importSnapshot = { ...importSnapshot, ...patch };
  for (const listener of [...importListeners]) listener();
}

function subscribeImport(listener: () => void) {
  importListeners.add(listener);
  return () => {
    importListeners.delete(listener);
  };
}

function getImportSnapshot(): ImportSnapshot {
  return importSnapshot;
}

export function progressLabel(processed: number, total: number): string {
  return `Aggiungo i brani: ${processed} di ${total}`;
}

function reportProgress(processed: number, total: number) {
  const now = Date.now();
  const due =
    lastAnnounced.processed < 0 ||
    processed >= total ||
    processed - lastAnnounced.processed >= ANNOUNCE_EVERY_FILES ||
    now - lastAnnounced.at >= ANNOUNCE_EVERY_MS;
  if (due) lastAnnounced = { processed, at: now };
  setImportSnapshot({
    progress: { processed, total },
    ...(due ? { announcement: progressLabel(processed, total) } : {}),
  });
}

function endImport(added: number) {
  lastAnnounced = { processed: -1, at: 0 };
  setImportSnapshot({
    progress: null,
    announcement: '',
    finished: importSnapshot.finished + 1,
    lastAdded: added,
  });
}

/** Avvia l'aggiunta (una alla volta). addFiles copia subito l'elenco: poi l'input si può svuotare. */
function startImport(files: FileList): boolean {
  if (importSnapshot.progress) return false;
  const total = files.length;
  lastAnnounced = { processed: -1, at: 0 };
  let pending: Promise<AddFilesResult>;
  try {
    pending = addFiles(files, {
      onProgress: ({ processed, total: of }) => reportProgress(processed, of),
    });
  } catch (error) {
    pending = Promise.reject(error);
  }
  reportProgress(0, total);
  void pending.then(
    (result) => {
      const summary = importSummary(result);
      const options = summary.description ? { description: summary.description } : undefined;
      if (summary.tone === 'success') toast.success(summary.title, options);
      else toast.error(summary.title, options);
      endImport(result.added.length);
    },
    (error: unknown) => {
      toast.error(
        isUnavailable(error)
          ? LOCAL_MUSIC_UNSUPPORTED_MESSAGE
          : 'Non è stato possibile aggiungere i brani. Riprova.',
      );
      endImport(0);
    },
  );
  return true;
}

type RowProps = {
  track: LocalTrack;
  index: number;
  coverUrl: string | null;
  current: boolean;
  playing: boolean;
  durationSeconds: number | null;
  canPlay: boolean;
  onPlay: (track: LocalTrack) => void;
  onRemove: (track: LocalTrack, index: number) => void;
};

// Memo: the list re-renders only when its own props change.
const LocalTrackRow = memo(function LocalTrackRow({
  track,
  index,
  coverUrl,
  current,
  playing,
  durationSeconds,
  canPlay,
  onPlay,
  onRemove,
}: RowProps) {
  const meta = [track.artist, track.album].filter(Boolean).join(' · ') || 'Artista sconosciuto';
  const duration = formatTrackDuration(durationSeconds);
  const playLabel = current
    ? playing
      ? `Metti in pausa ${track.title}`
      : `Riprendi ${track.title}`
    : `Riproduci ${track.title}`;
  const spokenDuration = duration ? (
    <>
      <span className="sr-only">Durata </span>
      {duration}
    </>
  ) : null;
  return (
    <li className={styles.row} data-local-id={track.id} aria-current={current ? 'true' : undefined}>
      <div className={styles.art}>
        {coverUrl ? (
          // Not next/image: it loads blob: URLs eagerly. The cover exists only near the screen.
          // biome-ignore lint/performance/noImgElement: blob: object URL, lazy by design.
          <img src={coverUrl} alt="" width={48} height={48} loading="lazy" decoding="async" />
        ) : (
          <span aria-hidden="true">{artInitial(track.title)}</span>
        )}
      </div>
      <div className={styles.copy}>
        <span className={styles.titleLine}>
          {current ? <AudioLines aria-hidden="true" className={styles.nowIcon} /> : null}
          <strong className={styles.title} title={track.title}>
            {track.title}
          </strong>
        </span>
        <span className={styles.meta}>
          <span className={styles.metaText}>{meta}</span>
          {/* On a phone the duration joins this line (the column is hidden there). */}
          {spokenDuration ? <span className={styles.metaDuration}>{spokenDuration}</span> : null}
          {current ? <span className="sr-only"> · in riproduzione</span> : null}
        </span>
      </div>
      <span className={styles.duration}>{spokenDuration}</span>
      <div className={styles.rowActions}>
        <button
          type="button"
          className={`${styles.iconButton} ${styles.playButton}`}
          data-local-play=""
          aria-label={playLabel}
          disabled={!canPlay}
          onClick={() => onPlay(track)}
        >
          {current && playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={styles.iconButton}
              aria-label={`Altre azioni per ${track.title}`}
            >
              <EllipsisVertical aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuItem onSelect={() => onRemove(track, index)}>
              <Trash2 aria-hidden="true" />
              Rimuovi da questo dispositivo
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
});

type ListProps = {
  tracks: readonly LocalTrack[];
  covers: Readonly<Record<string, string>>;
  currentId: string | null;
  playing: boolean;
  /** What the player knows of the current local item's duration (for files saved without one). */
  currentDuration: number | null;
  canPlay: boolean;
  onPlay: (track: LocalTrack) => void;
  onRemove: (track: LocalTrack, index: number) => void;
  listRef: RefObject<HTMLOListElement | null>;
};

// Memo: the section reads the whole player context, which changes several times a second while
// something plays (elapsed time). Only primitives reach the list, so those ticks skip the rows.
const LocalTrackList = memo(function LocalTrackList({
  tracks,
  covers,
  currentId,
  playing,
  currentDuration,
  canPlay,
  onPlay,
  onRemove,
  listRef,
}: ListProps) {
  return (
    <ol
      ref={listRef}
      id="local-music-list"
      className={styles.list}
      aria-label="Brani su questo dispositivo"
    >
      {tracks.map((track, index) => {
        const current = currentId === qualifiedIdOf(track);
        return (
          <LocalTrackRow
            key={track.id}
            track={track}
            index={index}
            coverUrl={covers[track.id] ?? null}
            current={current}
            playing={current && playing}
            durationSeconds={track.durationSeconds ?? (current ? currentDuration : null)}
            canPlay={canPlay}
            onPlay={onPlay}
            onRemove={onRemove}
          />
        );
      })}
    </ol>
  );
});

export function LocalMusicSection() {
  const player = useOptionalMusicPlayer();
  // Latest player for async handlers (a removal that finishes after the track changed).
  const playerRef = useRef(player);
  playerRef.current = player;

  const [phase, setPhase] = useState<Phase>('checking');
  const [tracks, setTracks] = useState<LocalTrack[]>([]);
  const [stats, setStats] = useState<LocalMusicUsage | null>(null);
  const [covers, setCovers] = useState<Record<string, string>>({});
  // Rows near the screen (IntersectionObserver); null: no observer, the first rows count.
  const [near, setNear] = useState<ReadonlySet<string> | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [device, setDevice] = useState<Device | null>(null);
  const [showHomeHint, setShowHomeHint] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const importState = useSyncExternalStore(subscribeImport, getImportSnapshot, getImportSnapshot);
  const progress = importState.progress;

  const aliveRef = useRef(false);
  const loadSeqRef = useRef(0);
  const persistenceAskedRef = useRef(false);
  const finishedSeenRef = useRef(importState.finished);
  const coverHandlesRef = useRef(new Map<string, ObjectUrlHandle>());
  const coverPendingRef = useRef(new Set<string>());
  // Library ids with a cover: a cover read that lands for an id no longer here is revoked.
  const coverLibraryRef = useRef(new Set<string>());
  // Covers wanted now (on or near the screen): never evicted by the cap.
  const coverWantedRef = useRef(new Set<string>());
  // When each cover was last wanted (least recently wanted is evicted first).
  const coverSeenRef = useRef(new Map<string, number>());
  const coverTickRef = useRef(0);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const nearIdsRef = useRef(new Set<string>());
  const focusAfterRef = useRef<FocusTarget | null>(null);
  const clearedRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLOListElement>(null);

  const refresh = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    try {
      const [list, measured] = await Promise.all([listTracks(), usage().catch(() => null)]);
      if (!aliveRef.current || seq !== loadSeqRef.current) return;
      setTracks(list);
      setStats(measured);
      setPhase('ready');
    } catch (error) {
      if (!aliveRef.current || seq !== loadSeqRef.current) return;
      setPhase(isUnavailable(error) ? 'unsupported' : 'error');
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    const env = currentDeviceEnv();
    setDevice(env ? { ios: isIosDevice(env), iosTab: isIosBrowserTab(env) } : null);
    if (!isLocalMusicSupported()) {
      setPhase('unsupported');
    } else {
      setPhase('loading');
      void refresh();
    }
    return () => {
      aliveRef.current = false;
    };
  }, [refresh]);

  const shown = useMemo(
    () =>
      expanded || tracks.length <= INITIAL_VISIBLE_ROWS
        ? tracks
        : tracks.slice(0, INITIAL_VISIBLE_ROWS),
    [tracks, expanded],
  );

  // Unmount: every cover URL made here is revoked.
  useEffect(() => {
    const handles = coverHandlesRef.current;
    return () => {
      for (const handle of handles.values()) handle.revoke();
      handles.clear();
    };
  }, []);

  // One observer for the list: a row is "near" within a screen height of the viewport.
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const nearIds = nearIdsRef.current;
    const observer = new IntersectionObserver(
      (entries) => {
        let changed = false;
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.localId;
          if (!id) continue;
          if (entry.isIntersecting) {
            if (!nearIds.has(id)) {
              nearIds.add(id);
              changed = true;
            }
          } else if (nearIds.delete(id)) {
            changed = true;
          }
        }
        if (changed && aliveRef.current) setNear(new Set(nearIds));
      },
      { rootMargin: COVER_ROOT_MARGIN },
    );
    observerRef.current = observer;
    setNear(new Set());
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, []);

  // The rows on the page change: observe them again (the observer reports each one once).
  useEffect(() => {
    const observer = observerRef.current;
    const list = listRef.current;
    if (!observer) return;
    observer.disconnect();
    nearIdsRef.current.clear();
    if (!list || shown.length === 0) {
      setNear(new Set());
      return;
    }
    for (const row of list.querySelectorAll<HTMLElement>('li[data-local-id]')) {
      observer.observe(row);
    }
  }, [shown]);

  /** Revokes the least recently wanted covers beyond MAX_LIVE_COVERS (never one wanted now). */
  const trimCovers = useCallback(() => {
    const handles = coverHandlesRef.current;
    if (handles.size <= MAX_LIVE_COVERS) return;
    const seen = coverSeenRef.current;
    const evictable = [...handles.keys()]
      .filter((id) => !coverWantedRef.current.has(id))
      .sort((a, b) => (seen.get(a) ?? 0) - (seen.get(b) ?? 0));
    const evicted = evictable.slice(0, handles.size - MAX_LIVE_COVERS);
    if (evicted.length === 0) return;
    for (const id of evicted) {
      handles.get(id)?.revoke();
      handles.delete(id);
    }
    const gone = new Set(evicted);
    setCovers((current) => {
      const next: Record<string, string> = {};
      for (const [id, url] of Object.entries(current)) if (!gone.has(id)) next[id] = url;
      return next;
    });
  }, []);

  // Covers follow the rows near the screen: those get an object URL (6 reads at a time), removed
  // tracks are revoked at once, and past MAX_LIVE_COVERS the least recently seen go. Each URL is
  // kept in coverHandlesRef as soon as it exists, so unmounting revokes it even mid-read.
  useEffect(() => {
    const handles = coverHandlesRef.current;
    const pending = coverPendingRef.current;
    const library = new Set(tracks.filter((track) => track.hasArtwork).map((track) => track.id));
    coverLibraryRef.current = library;
    const stale = [...handles.keys()].filter((id) => !library.has(id));
    for (const id of stale) {
      handles.get(id)?.revoke();
      handles.delete(id);
      coverSeenRef.current.delete(id);
    }
    if (stale.length > 0) {
      setCovers((current) => {
        const next: Record<string, string> = {};
        for (const [id, url] of Object.entries(current)) if (library.has(id)) next[id] = url;
        return next;
      });
    }
    const candidates = shown.filter((track) => track.hasArtwork).map((track) => track.id);
    const wanted =
      near === null
        ? candidates.slice(0, MAX_LIVE_COVERS)
        : candidates.filter((id) => near.has(id));
    coverWantedRef.current = new Set(wanted);
    coverTickRef.current += 1;
    for (const id of wanted) coverSeenRef.current.set(id, coverTickRef.current);
    trimCovers();
    const missing = wanted.filter((id) => !handles.has(id) && !pending.has(id));
    if (missing.length === 0) return;
    let cancelled = false;
    const load = async (id: string) => {
      pending.add(id);
      let handle: ObjectUrlHandle | null = null;
      try {
        handle = await createObjectUrlForArtwork(id);
      } catch {
        handle = null;
      } finally {
        pending.delete(id);
      }
      if (!handle) return;
      // Unmounted, removed meanwhile, or already shown: nobody will use this URL.
      if (!aliveRef.current || !coverLibraryRef.current.has(id) || handles.has(id)) {
        handle.revoke();
        return;
      }
      handles.set(id, handle);
      const url = handle.url;
      setCovers((current) => ({ ...current, [id]: url }));
    };
    void (async () => {
      // A newer render takes over the ids not started yet (in-flight ones finish here).
      for (let start = 0; start < missing.length && !cancelled; start += COVER_BATCH) {
        const batch = missing
          .slice(start, start + COVER_BATCH)
          .filter((id) => coverWantedRef.current.has(id) && !handles.has(id) && !pending.has(id));
        await Promise.all(batch.map(load));
      }
      if (aliveRef.current) trimCovers();
    })();
    return () => {
      cancelled = true;
    };
  }, [tracks, shown, near, trimCovers]);

  // After a removal or "Mostra tutti": focus that row (or the one before), else "Aggiungi brani".
  useEffect(() => {
    const target = focusAfterRef.current;
    if (target === null || phase !== 'ready') return;
    focusAfterRef.current = null;
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('[data-local-play]');
    const button =
      typeof target === 'number' && buttons && buttons.length > 0
        ? buttons[Math.max(0, Math.min(target, shown.length - 1, buttons.length - 1))]
        : null;
    (button ?? addButtonRef.current)?.focus();
  }, [shown, phase]);

  const askPersistence = useCallback(async () => {
    if (persistenceAskedRef.current) return;
    persistenceAskedRef.current = true;
    let result: PersistenceResult;
    try {
      result = await requestPersistence();
    } catch {
      result = 'denied';
    }
    if (result === 'granted' || !aliveRef.current) return;
    const env = currentDeviceEnv();
    if (env && isIosBrowserTab(env)) setShowHomeHint(true);
  }, []);

  // An import finished (started here or in a section that has unmounted since): reload the list.
  useEffect(() => {
    if (importState.finished === finishedSeenRef.current) return;
    finishedSeenRef.current = importState.finished;
    void refresh();
    if (importState.lastAdded > 0) void askPersistence();
  }, [importState.finished, importState.lastAdded, refresh, askPersistence]);

  // A long import: the tracks already saved show up every few files.
  const refreshStep = progress ? Math.floor(progress.processed / REFRESH_EVERY_FILES) : 0;
  useEffect(() => {
    if (refreshStep > 0) void refresh();
  }, [refreshStep, refresh]);

  const openPicker = () => {
    if (getImportSnapshot().progress) return;
    inputRef.current?.click();
  };

  const onFilesChosen = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const files = input.files;
    if (!files || files.length === 0) return;
    if (!startImport(files)) return;
    // addFiles has copied the (live) FileList: emptying the input now is safe, and lets the same
    // file be chosen again later.
    input.value = '';
  };

  const playFrom = useCallback(
    (track: LocalTrack) => {
      const current = playerRef.current;
      if (!current) return;
      const qualifiedId = qualifiedIdOf(track);
      if (current.currentTrack?.qualifiedId === qualifiedId) {
        void current.togglePlayback();
        return;
      }
      const queue = tracks.map(localTrackToPlayerTrack);
      const item =
        queue.find((entry) => entry.qualifiedId === qualifiedId) ?? localTrackToPlayerTrack(track);
      void current.playTrack(item, '', queue);
    },
    [tracks],
  );

  const playQueue = (order: readonly LocalTrack[]) => {
    const current = playerRef.current;
    const queue = order.map(localTrackToPlayerTrack);
    const first = queue[0];
    if (!current || !first) return;
    void current.playTrack(first, '', queue);
  };

  const removeOne = useCallback(
    async (track: LocalTrack, index: number) => {
      try {
        await removeTrack(track.id);
      } catch {
        toast.error(`Non è stato possibile rimuovere “${track.title}”. Riprova.`);
        return;
      }
      // Removed means gone from this device: it does not keep playing, wait in the queue or sit
      // preloaded in memory (the player stops if it was the current one).
      playerRef.current?.forgetLocalTracks([track.id]);
      toast.success(`“${track.title}” rimosso da questo dispositivo`);
      if (!aliveRef.current) return;
      focusAfterRef.current = index;
      await refresh();
    },
    [refresh],
  );

  const confirmClearAll = async (event: MouseEvent<HTMLButtonElement>) => {
    // The dialog stays open (and busy) until the library is really empty.
    event.preventDefault();
    if (clearing) return;
    setClearing(true);
    try {
      await clearAll();
    } catch {
      if (aliveRef.current) setClearing(false);
      toast.error('Non è stato possibile rimuovere i brani. Riprova.');
      return;
    }
    // Every local file leaves the player too; a stream that is playing goes on.
    playerRef.current?.forgetLocalTracks('all');
    toast.success('Tutti i brani sono stati rimossi da questo dispositivo');
    if (!aliveRef.current) return;
    clearedRef.current = true;
    focusAfterRef.current = 'add';
    setClearing(false);
    setConfirmOpen(false);
    setExpanded(false);
    await refresh();
  };

  const toggleExpanded = () => {
    if (expanded) {
      setExpanded(false);
      // The focus may sit in a row that goes away (Safari does not focus a clicked button): it
      // stays on the toggle, which is kept on screen as the list gets much shorter.
      toggleRef.current?.focus();
      window.requestAnimationFrame(() => {
        toggleRef.current?.scrollIntoView?.({ block: 'nearest' });
      });
      return;
    }
    // The first row that was hidden takes the focus.
    focusAfterRef.current = INITIAL_VISIBLE_ROWS;
    setExpanded(true);
  };

  const retry = () => {
    setPhase('loading');
    void refresh();
  };

  const importing = progress !== null;
  const ready = phase === 'ready';
  const hasTracks = ready && tracks.length > 0;
  const currentId = player?.currentTrack?.qualifiedId ?? null;
  const playerPlaying = player?.status === 'playing';
  const currentDuration =
    currentId?.startsWith('local:') &&
    player &&
    Number.isFinite(player.durationSeconds) &&
    player.durationSeconds > 0
      ? player.durationSeconds
      : null;
  const bytes = stats?.bytes ?? tracks.reduce((sum, track) => sum + track.size, 0);
  const percent = progress && progress.total > 0 ? (progress.processed / progress.total) * 100 : 0;
  const hiddenRows = tracks.length - INITIAL_VISIBLE_ROWS;

  return (
    <section
      id={LOCAL_MUSIC_SECTION_ID}
      className={styles.section}
      aria-labelledby="local-music-heading"
    >
      <header className={styles.header}>
        <p className={styles.eyebrow}>SUL TUO DISPOSITIVO</p>
        <h2 id="local-music-heading">La tua musica</h2>
        <p className={styles.lead}>{LOCAL_MUSIC_PRIVACY_LINE}</p>
      </header>

      {phase === 'unsupported' ? (
        <p className={styles.notice}>
          <Info aria-hidden="true" />
          {LOCAL_MUSIC_UNSUPPORTED_MESSAGE}
        </p>
      ) : phase === 'checking' ? (
        <p className={styles.state}>Carico i brani di questo dispositivo…</p>
      ) : (
        <>
          {/* Listening first; the add button keeps its slot (same element, same focus target). */}
          <div className={styles.actions}>
            {hasTracks ? (
              <>
                <Button
                  type="button"
                  className={styles.action}
                  disabled={!player}
                  onClick={() => playQueue(tracks)}
                >
                  <Play aria-hidden="true" />
                  Riproduci tutto
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className={styles.action}
                  disabled={!player}
                  aria-label="Riproduci in ordine casuale"
                  onClick={() => playQueue(shuffledCopy(tracks))}
                >
                  <Shuffle aria-hidden="true" />
                  Casuale
                </Button>
              </>
            ) : null}
            <Button
              ref={addButtonRef}
              type="button"
              variant={hasTracks ? 'outline' : 'default'}
              className={styles.action}
              aria-disabled={importing || undefined}
              onClick={openPicker}
            >
              <Plus aria-hidden="true" />
              Aggiungi brani
            </Button>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept={LOCAL_MUSIC_ACCEPT}
              className={styles.fileInput}
              tabIndex={-1}
              aria-hidden="true"
              onChange={onFilesChosen}
            />
          </div>

          <div className={importing ? styles.progress : 'sr-only'}>
            {/* Seen on every file; spoken only now and then (the <output> below). */}
            <p className={styles.progressText} data-import-progress="">
              {progress ? progressLabel(progress.processed, progress.total) : ''}
            </p>
            <output aria-live="polite" className="sr-only">
              {importState.announcement}
            </output>
            {progress ? (
              <Progress
                value={percent}
                aria-label="Avanzamento dell'aggiunta"
                aria-valuetext={`${progress.processed} di ${progress.total}`}
                className={styles.progressBar}
              />
            ) : null}
          </div>

          {showHomeHint ? (
            // Appears after an import: announced (an <output> is a polite status region).
            <output className={styles.hint}>
              <Info aria-hidden="true" />
              {HOME_SCREEN_HINT}
            </output>
          ) : device?.iosTab && ready && tracks.length === 0 && !importing ? (
            // Before the first import: the songs belong in the Home-screen app, not in Safari.
            <p className={styles.hint}>
              <Info aria-hidden="true" />
              {HOME_SCREEN_HINT}
            </p>
          ) : null}

          {phase === 'loading' ? (
            <p className={styles.state}>Carico i brani di questo dispositivo…</p>
          ) : phase === 'error' ? (
            <div className={styles.notice}>
              <Info aria-hidden="true" />
              <span>{LOCAL_MUSIC_READ_ERROR}</span>
              <Button type="button" variant="outline" size="sm" onClick={retry}>
                Riprova
              </Button>
            </div>
          ) : tracks.length === 0 ? (
            <div className={styles.empty}>
              <Music aria-hidden="true" />
              <strong>Nessun brano su questo dispositivo.</strong>
              <span>
                Tocca “Aggiungi brani” e scegli file MP3, M4A, AAC, WAV, FLAC o OGG: si ascoltano
                anche senza rete e non contano negli ascolti del piano Free.
              </span>
              {device?.ios ? <span>{IOS_FILES_HINT}</span> : null}
            </div>
          ) : (
            <>
              <LocalTrackList
                tracks={shown}
                covers={covers}
                currentId={currentId}
                playing={playerPlaying}
                currentDuration={currentDuration}
                canPlay={player !== null}
                onPlay={playFrom}
                onRemove={removeOne}
                listRef={listRef}
              />
              {hiddenRows > 0 ? (
                <Button
                  ref={toggleRef}
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={styles.more}
                  aria-expanded={expanded}
                  aria-controls="local-music-list"
                  onClick={toggleExpanded}
                >
                  {expanded ? 'Mostra meno' : `Mostra tutti i ${tracks.length} brani`}
                </Button>
              ) : null}
            </>
          )}

          {hasTracks ? (
            <footer className={styles.footer}>
              <p>{usageLine(tracks.length, bytes)}</p>
              <AlertDialog
                open={confirmOpen}
                onOpenChange={(open) => {
                  if (!clearing) setConfirmOpen(open);
                }}
              >
                <AlertDialogTrigger asChild>
                  <Button type="button" variant="ghost" size="sm" className={styles.clearAll}>
                    <Trash2 aria-hidden="true" />
                    Rimuovi tutti
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent
                  onCloseAutoFocus={(event) => {
                    // The trigger disappears with the list: focus "Aggiungi brani" instead.
                    if (!clearedRef.current) return;
                    clearedRef.current = false;
                    event.preventDefault();
                    addButtonRef.current?.focus();
                  }}
                >
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      Rimuovere tutti i brani da questo dispositivo?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {tracks.length === 1
                        ? 'Il brano e la sua copertina vengono cancellati da questo dispositivo. Per riascoltarlo dovrai aggiungerlo di nuovo.'
                        : `I ${tracks.length} brani e le loro copertine vengono cancellati da questo dispositivo. Per riascoltarli dovrai aggiungerli di nuovo.`}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={clearing}>Annulla</AlertDialogCancel>
                    <AlertDialogAction
                      className={styles.destructive}
                      aria-disabled={clearing || undefined}
                      onClick={(event) => void confirmClearAll(event)}
                    >
                      Rimuovi tutti
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </footer>
          ) : null}
        </>
      )}
    </section>
  );
}

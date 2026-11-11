// @polsia:user-owned — regole pure per i controlli di sistema del player (Media Session API):
// schermata di blocco e Centro di Controllo su iPhone (Safari 15+), notifica multimediale di
// Chrome su Android (scheda e app TWA), tasti delle cuffie e della tastiera.
//
// Convenzioni seguite (come le app native Apple e Android):
// - Musica: brano precedente / successivo. iOS mostra O i tasti precedente/successivo O i salti
//   ±secondi, mai entrambi: per la musica i salti vanno tolti esplicitamente (handler null).
// - Podcast: indietro 15 s / avanti 30 s (come Apple Podcasts), niente cambio episodio.
// - Radio in diretta: nessun cursore né salto (non si può spostare una diretta); cambio stazione
//   solo se la coda ha altre stazioni.
// - Video YouTube: nessun salto; il play da sistema è consentito solo a pagina visibile (lo
//   decide il player, non questo modulo).

export type MediaSessionKind = 'music' | 'podcast' | 'radio' | 'video';

/** Tipo di controlli di sistema per una modalità di riproduzione del player. */
export function mediaSessionKind(mode: string | null | undefined): MediaSessionKind {
  if (mode === 'radio') return 'radio';
  if (mode === 'podcast') return 'podcast';
  if (mode === 'youtube' || mode === 'song') return 'video';
  return 'music';
}

export const MEDIA_SESSION_ACTIONS = [
  'play',
  'pause',
  'stop',
  'previoustrack',
  'nexttrack',
  'seekbackward',
  'seekforward',
  'seekto',
] as const satisfies readonly MediaSessionAction[];

export type SessionAction = (typeof MEDIA_SESSION_ACTIONS)[number];
export type ActionPlan = Record<SessionAction, boolean>;

/** Apple Podcasts e le app podcast Android: indietro 15 secondi, avanti 30. */
export const PODCAST_SKIP_BACK_SECONDS = 15;
export const PODCAST_SKIP_FORWARD_SECONDS = 30;

/**
 * Quali azioni registrare (true) e quali azzerare esplicitamente (false → handler null).
 * Su Chrome un controllo compare solo se ha un handler; su iOS registrare i salti ±secondi
 * sostituisce precedente/successivo.
 */
export function mediaSessionActionPlan(input: {
  kind: MediaSessionKind;
  hasNext: boolean;
  hasPrevious: boolean;
}): ActionPlan {
  const plan: ActionPlan = {
    play: true,
    pause: true,
    stop: true,
    previoustrack: false,
    nexttrack: false,
    seekbackward: false,
    seekforward: false,
    seekto: false,
  };
  switch (input.kind) {
    case 'music':
      // "Precedente" riavvia il brano oltre i 5 secondi, come Apple Music: sempre disponibile.
      return { ...plan, previoustrack: true, nexttrack: input.hasNext, seekto: true };
    case 'podcast':
      return { ...plan, seekbackward: true, seekforward: true, seekto: true };
    case 'radio':
      return { ...plan, previoustrack: input.hasPrevious, nexttrack: input.hasNext };
    case 'video':
      return { ...plan, previoustrack: true, nexttrack: input.hasNext };
  }
}

/** Posizione di destinazione di un'azione di seek, già limitata a [0, durata]; null se non valida. */
export function seekTargetSeconds(
  action: 'seekbackward' | 'seekforward' | 'seekto',
  details: Pick<MediaSessionActionDetails, 'seekOffset' | 'seekTime'>,
  media: { currentTime: number; duration: number },
): number | null {
  const current = Number.isFinite(media.currentTime) ? media.currentTime : 0;
  let target: number;
  if (action === 'seekto') {
    if (typeof details.seekTime !== 'number' || !Number.isFinite(details.seekTime)) return null;
    target = details.seekTime;
  } else {
    const fallback =
      action === 'seekbackward' ? PODCAST_SKIP_BACK_SECONDS : PODCAST_SKIP_FORWARD_SECONDS;
    const offset =
      typeof details.seekOffset === 'number' &&
      Number.isFinite(details.seekOffset) &&
      details.seekOffset > 0
        ? details.seekOffset
        : fallback;
    target = action === 'seekbackward' ? current - offset : current + offset;
  }
  const upper = Number.isFinite(media.duration) && media.duration > 0 ? media.duration : target;
  return Math.max(0, Math.min(target, upper));
}

type SeekableMedia = { currentTime: number; fastSeek?: (time: number) => void };

/** Seek dell'elemento: fastSeek per i trascinamenti rapidi del cursore di sistema, se c'è. */
export function seekMediaElement(media: SeekableMedia, seconds: number, fast: boolean) {
  if (fast && typeof media.fastSeek === 'function') {
    media.fastSeek(seconds);
    return;
  }
  media.currentTime = seconds;
}

/**
 * Stato di posizione per il cursore di sistema. null = nessun cursore (diretta, durata ignota).
 * Mai Infinity né playbackRate 0: WebKit, Chrome e Firefox lanciano TypeError.
 */
export function mediaPositionState(input: {
  duration: number;
  currentTime: number;
  playbackRate: number;
  live: boolean;
}): MediaPositionState | null {
  if (input.live || !Number.isFinite(input.duration) || input.duration <= 0) return null;
  const current = Number.isFinite(input.currentTime) ? input.currentTime : 0;
  return {
    duration: input.duration,
    position: Math.max(0, Math.min(current, input.duration)),
    playbackRate:
      Number.isFinite(input.playbackRate) && input.playbackRate > 0 ? input.playbackRate : 1,
  };
}

/** Applica (o azzera, con null) lo stato di posizione; i browser senza supporto lo ignorano. */
export function applyPositionState(
  session: Pick<MediaSession, 'setPositionState'> | null | undefined,
  state: MediaPositionState | null,
) {
  if (!session || typeof session.setPositionState !== 'function') return;
  try {
    if (state) session.setPositionState(state);
    else session.setPositionState();
  } catch {
    // Older engines reject an empty call or an out-of-range value: no scrubber then.
  }
}

/** Icone PNG di Solco quando il brano non ha copertina (l'SVG non è mostrato da tutti i sistemi). */
export const FALLBACK_ARTWORK: readonly MediaImage[] = [
  { src: '/solco-icon-512.png', sizes: '512x512', type: 'image/png' },
  { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
];

function artworkUrl(url: string) {
  try {
    return new URL(url, 'https://solco.invalid');
  } catch {
    return null;
  }
}

/** Lato reale della copertina, se l'URL lo dichiara (Audius 480x480.jpg, iTunes 600x600bb.jpg, Jamendo width=300). */
export function artworkSize(url: string): number | null {
  const parsed = artworkUrl(url);
  if (!parsed) return null;
  const named = /\/(\d{2,4})x(\d{2,4})[a-z]*\.(?:jpe?g|png|webp)$/i.exec(parsed.pathname);
  if (named?.[1] && named[1] === named[2]) return Number(named[1]);
  const width = parsed.searchParams.get('width');
  if (width && /^\d{2,4}$/.test(width)) return Number(width);
  return null;
}

function artworkType(url: string) {
  const path = artworkUrl(url)?.pathname.toLowerCase() ?? '';
  if (/\.jpe?g$/.test(path)) return 'image/jpeg';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.webp')) return 'image/webp';
  return null;
}

/**
 * Elenco artwork per MediaMetadata con le dimensioni vere (Android punta a 512x512, iOS sceglie la
 * più adatta). Le icone di riserva vanno solo senza copertina: Chrome preferirebbe il PNG 512x512
 * a una copertina 480x480 o senza dimensioni dichiarate.
 */
export function mediaArtwork(url: string | null | undefined): MediaImage[] {
  if (!url) return FALLBACK_ARTWORK.map((image) => ({ ...image }));
  const image: MediaImage = { src: url };
  const size = artworkSize(url);
  if (size) image.sizes = `${size}x${size}`;
  const type = artworkType(url);
  if (type) image.type = type;
  return [image];
}

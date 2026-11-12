// @polsia:user-owned — quali file audio il browser sa riprodurre e quanto durano.
//
// Il tipo di un File viene dal sistema operativo e a volte manca (Android, Windows con .m4a e
// .flac) o usa un alias ('audio/mp3', 'audio/x-flac'): resolveAudioType lo normalizza, ripiega
// sull'estensione se il tipo è vuoto, generico o un audio/* che non conosce (Android e macOS
// dichiarano anche 'audio/aac-adts', 'audio/mp4a-latm', 'audio/x-hx-aac-adts'…), e accetta il
// file solo se il browser lo sa riprodurre (canPlayType !== ''), provando anche le varianti
// equivalenti (audio/mp4 ↔ x-m4a, audio/wav ↔ x-wav) perché ogni motore ne riconosce di diverse.
//
// La durata si legge con un elemento Audio temporaneo su un object URL (revocato sempre). Su iOS
// i metadati spesso non arrivano senza un gesto dell'utente: dopo 5 s la durata resta null e il
// player la completa quando il brano suona (setTrackDuration).

import { plausibleDuration } from '@/lib/local-music/tag-utils';
import { SUPPORTED_AUDIO_TYPES, type SupportedAudioType } from '@/lib/local-music/types';

export type CanPlayType = (mimeType: string) => string;

const TYPE_ALIASES: Record<string, SupportedAudioType> = {
  'audio/mp3': 'audio/mpeg',
  'audio/x-mp3': 'audio/mpeg',
  'audio/mpeg3': 'audio/mpeg',
  'audio/x-mpeg': 'audio/mpeg',
  'audio/x-mpeg-3': 'audio/mpeg',
  'audio/mpg': 'audio/mpeg',
  'audio/m4a': 'audio/x-m4a',
  'audio/x-aac': 'audio/aac',
  'audio/aac-adts': 'audio/aac',
  'audio/x-hx-aac-adts': 'audio/aac',
  'audio/x-flac': 'audio/flac',
  'audio/wave': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
  'application/ogg': 'audio/ogg',
  'audio/opus': 'audio/ogg',
  'audio/vorbis': 'audio/ogg',
};

const EXTENSION_TYPES: Record<string, SupportedAudioType> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
};

const EQUIVALENT_TYPES: Record<SupportedAudioType, readonly SupportedAudioType[]> = {
  'audio/mpeg': ['audio/mpeg'],
  'audio/mp4': ['audio/mp4', 'audio/x-m4a'],
  'audio/x-m4a': ['audio/x-m4a', 'audio/mp4'],
  'audio/aac': ['audio/aac'],
  'audio/wav': ['audio/wav', 'audio/x-wav'],
  'audio/x-wav': ['audio/x-wav', 'audio/wav'],
  'audio/flac': ['audio/flac'],
  'audio/ogg': ['audio/ogg'],
};

function isSupportedType(value: string): value is SupportedAudioType {
  return (SUPPORTED_AUDIO_TYPES as readonly string[]).includes(value);
}

function declaredType(type: string): SupportedAudioType | null | 'unknown' {
  const base = (type.split(';')[0] ?? '').trim().toLowerCase();
  if (base === '' || base === 'application/octet-stream') return 'unknown';
  if (isSupportedType(base)) return base;
  const alias = TYPE_ALIASES[base];
  if (alias) return alias;
  // Un audio/* sconosciuto non basta a rifiutare il file: decide l'estensione.
  return base.startsWith('audio/') ? 'unknown' : null;
}

function typeFromExtension(name: string): SupportedAudioType | null {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  return EXTENSION_TYPES[name.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * Tipo audio accettato per un file (dal tipo dichiarato o, se vuoto, generico o un audio/* non
 * riconosciuto, dall'estensione) che il browser sa riprodurre, o null.
 */
export function resolveAudioType(
  type: string,
  name: string,
  canPlayType: CanPlayType,
): SupportedAudioType | null {
  const declared = declaredType(typeof type === 'string' ? type : '');
  const candidate =
    declared === 'unknown' ? typeFromExtension(typeof name === 'string' ? name : '') : declared;
  if (!candidate) return null;
  for (const option of EQUIVALENT_TYPES[candidate]) {
    let answer = '';
    try {
      answer = canPlayType(option);
    } catch {
      answer = '';
    }
    if (answer !== '') return option;
  }
  return null;
}

let probeElement: HTMLAudioElement | null | undefined;

/** canPlayType di un elemento Audio del browser; '' fuori dal browser o in caso d'errore. */
export function browserCanPlayType(mimeType: string): string {
  try {
    if (probeElement === undefined) {
      if (typeof Audio === 'function') probeElement = new Audio();
      else if (typeof document !== 'undefined') probeElement = document.createElement('audio');
      else probeElement = null;
    }
    return probeElement?.canPlayType(mimeType) ?? '';
  } catch {
    return '';
  }
}

export const DURATION_PROBE_TIMEOUT_MS = 5000;

export type DurationProbe = { seconds: number | null; timedOut: boolean };

export type UrlApi = {
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
};

/** Elemento minimo usato per leggere la durata (un HTMLAudioElement nel browser). */
export type ProbeAudioElement = Pick<
  HTMLAudioElement,
  'addEventListener' | 'removeEventListener' | 'removeAttribute' | 'load' | 'duration'
> & { preload: string; muted: boolean; src: string };

export type ProbeDurationOptions = {
  timeoutMs?: number;
  createAudio?: () => ProbeAudioElement;
  urlApi?: UrlApi;
};

function defaultCreateAudio(): ProbeAudioElement {
  return new Audio();
}

/** Durata di un Blob audio letta dai metadati; null su errore o dopo il timeout. */
export function probeDuration(
  blob: Blob,
  options: ProbeDurationOptions = {},
): Promise<DurationProbe> {
  const timeoutMs = options.timeoutMs ?? DURATION_PROBE_TIMEOUT_MS;
  const urlApi = options.urlApi ?? (typeof URL === 'undefined' ? undefined : URL);
  const createAudio = options.createAudio ?? defaultCreateAudio;

  return new Promise((resolve) => {
    let audio: ProbeAudioElement | null = null;
    let url: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const onMetadata = () => finish(audio ? plausibleDuration(audio.duration) : null, false);
    const onError = () => finish(null, false);

    function finish(seconds: number | null, timedOut: boolean) {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (audio) {
        audio.removeEventListener('loadedmetadata', onMetadata);
        audio.removeEventListener('error', onError);
        try {
          audio.removeAttribute('src');
          audio.load();
        } catch {
          // Elemento già scollegato: niente da liberare.
        }
      }
      if (url !== null && urlApi) {
        try {
          urlApi.revokeObjectURL(url);
        } catch {
          // URL già revocato.
        }
      }
      resolve({ seconds, timedOut });
    }

    try {
      if (!urlApi || typeof urlApi.createObjectURL !== 'function') {
        finish(null, false);
        return;
      }
      audio = createAudio();
      url = urlApi.createObjectURL(blob);
      audio.preload = 'metadata';
      audio.muted = true;
      audio.addEventListener('loadedmetadata', onMetadata);
      audio.addEventListener('error', onError);
      timer = setTimeout(() => finish(null, true), timeoutMs);
      audio.src = url;
      audio.load();
    } catch {
      finish(null, false);
    }
  });
}

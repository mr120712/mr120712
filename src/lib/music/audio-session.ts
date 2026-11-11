// @polsia:user-owned — sessione audio del browser per l'ascolto in background.
//
// Audio Session API (WebKit: Safari e iOS 16.4+; altrove assente e quindi ignorata): con
// navigator.audioSession.type = 'playback' la pagina dichiara che riproduce musica o podcast,
// come AVAudioSession.Category.playback nelle app iOS native. Apple consiglia di attivare la
// sessione solo quando la riproduzione parte, così le altre app non vengono interrotte prima:
// per questo il player la imposta subito prima di play(), mai al caricamento della pagina, e mai
// per i video YouTube.

export type AudioSessionType =
  | 'auto'
  | 'playback'
  | 'transient'
  | 'transient-solo'
  | 'ambient'
  | 'play-and-record';

type NavigatorWithAudioSession = { audioSession?: { type: string } | null };

function currentNavigator(): NavigatorWithAudioSession | undefined {
  return typeof navigator === 'undefined' ? undefined : (navigator as NavigatorWithAudioSession);
}

/** Imposta il tipo di sessione audio se il browser lo supporta; true se applicato. */
export function setAudioSessionType(
  type: AudioSessionType,
  nav: NavigatorWithAudioSession | undefined = currentNavigator(),
): boolean {
  try {
    const session = nav?.audioSession;
    if (!session) return false;
    if (session.type !== type) session.type = type;
    return true;
  } catch {
    // A future engine may reject an unknown value: keep the browser's default.
    return false;
  }
}

/** Musica o podcast in partenza: sessione 'playback' (non mixata, non silenziata dal blocco). */
export function declarePlaybackSession(nav?: NavigatorWithAudioSession) {
  return setAudioSessionType('playback', nav ?? currentNavigator());
}

/** Player chiuso o video YouTube: si torna alla scelta del browser. */
export function releasePlaybackSession(nav?: NavigatorWithAudioSession) {
  return setAudioSessionType('auto', nav ?? currentNavigator());
}

/**
 * Sblocca l'elemento <audio> dentro il gesto dell'utente. Su iOS un elemento deve ricevere load()
 * o play() una volta da un tocco; dopo, src può cambiare e suonare senza gesto (anche dopo un
 * await). Non tocca un elemento che ha già una sorgente: è già stato sbloccato dal suo play().
 */
export function primeMediaElement(media: Pick<HTMLMediaElement, 'getAttribute' | 'load'> | null) {
  if (!media || media.getAttribute('src')) return false;
  try {
    media.load();
    return true;
  } catch {
    return false;
  }
}

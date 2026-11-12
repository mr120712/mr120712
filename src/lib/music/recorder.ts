// @polsia:user-owned — helper puri per la registrazione di un brano nel browser.
// Nessuna API del browser viene eseguita qui: così sono testabili.

/** Tipi MIME preferiti per MediaRecorder, dal più compatibile. */
const PREFERRED_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/mpeg',
];

/**
 * Sceglie il primo tipo supportato da MediaRecorder. Ritorna '' quando nessuno
 * è dichiarato supportato: in quel caso si lascia decidere il browser.
 */
export function pickRecorderMimeType(isTypeSupported: (type: string) => boolean): string {
  for (const type of PREFERRED_MIME_TYPES) {
    try {
      if (isTypeSupported(type)) return type;
    } catch {
      // Alcuni browser lanciano su tipi sconosciuti: prosegui.
    }
  }
  return '';
}

/** Rimuove i parametri (";codecs=opus") e normalizza: "audio/webm;codecs=opus" → "audio/webm". */
export function baseMimeType(fullType: string): string {
  return (fullType.split(';', 1)[0] ?? '').trim().toLowerCase();
}

const EXTENSION_BY_MIME: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
};

/** Estensione file per un tipo MIME di base; 'audio' come ripiego. */
export function extensionForMime(baseMime: string): string {
  return EXTENSION_BY_MIME[baseMime] ?? 'audio';
}

/** Nome file sicuro per il caricamento, derivato dal titolo. */
export function recordingFileName(title: string, baseMime: string): string {
  const slug =
    title
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'registrazione';
  return `${slug}.${extensionForMime(baseMime)}`;
}

/** mm:ss (o h:mm:ss oltre l'ora) per i secondi trascorsi. */
export function formatClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Durata massima di una registrazione (10 minuti): oltre, lo stop è automatico. */
export const MAX_RECORDING_SECONDS = 600;

/** Titolo predefinito basato su una data (passata dall'esterno per restare puro). */
export function defaultRecordingTitle(now: Date): string {
  const date = now.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
  const time = now.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  return `Registrazione ${date} ${time}`;
}

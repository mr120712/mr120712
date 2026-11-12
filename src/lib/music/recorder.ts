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

/**
 * MIME audio canonico per estensione file. Serve quando il browser NON dichiara un tipo:
 * moltissimi MP3 (e a volte M4A/WAV) arrivano da `<input type=file>` con `file.type` vuoto
 * o `application/octet-stream`, a seconda del sistema operativo. In quei casi deduciamo il
 * MIME dall'estensione così che il caricamento non venga rifiutato.
 */
// Solo estensioni audio-specifiche: .mp4/.webm sono contenitori anche video, quindi non li
// deduciamo come audio dalla sola estensione (un file in quei contenitori che è davvero audio
// passa comunque dal ramo `audio/*` dichiarato dal browser).
const MIME_BY_EXTENSION: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  aac: 'audio/aac',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  weba: 'audio/webm',
};

/** Estensioni audio accettate dal caricamento (per l'attributo `accept` e il controllo). */
export const AUDIO_UPLOAD_EXTENSIONS = Object.keys(MIME_BY_EXTENSION);

/** Estensione (minuscola, senza punto) di un nome file; '' se assente. */
function fileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : '';
}

/**
 * Tipo MIME audio da usare per caricare un file scelto dall'utente, oppure null se non è
 * riconoscibile come audio. Regole:
 *  - il browser dichiara già un tipo `audio/*` → lo usa così com'è (solo minuscolo);
 *  - tipo mancante o non-audio (es. '' o 'application/octet-stream') ma estensione audio nota
 *    (mp3, m4a, wav, flac, ogg…) → il MIME canonico dedotto dall'estensione;
 *  - altrimenti null.
 * Il MIME non vuoto è obbligatorio: `uploadPrivateFile` rifiuta i file con `type` vuoto, e il
 * controllo lato server confronta il MIME dichiarato con quello memorizzato.
 */
export function audioUploadMimeType(declaredType: string, fileName: string): string | null {
  const declared = declaredType.trim().toLowerCase();
  if (declared.startsWith('audio/')) return declared;
  return MIME_BY_EXTENSION[fileExtension(fileName)] ?? null;
}

/**
 * True se il File scelto va ricostruito con un MIME sintetico prima del caricamento: succede
 * quando il browser NON ha dichiarato un tipo audio (type vuoto o 'application/octet-stream'),
 * perché `uploadPrivateFile` rifiuta i file con `type` vuoto. Se il tipo è già audio/* il File
 * si usa così com'è.
 */
export function shouldReassignMime(declaredType: string): boolean {
  return !declaredType.trim().toLowerCase().startsWith('audio/');
}

/**
 * Messaggi italiani per i codici di errore di `uploadPrivateFile` (il modulo file-upload li
 * espone in inglese). `code` è `FileUploadError.code`; i codici sconosciuti usano il ripiego.
 */
const UPLOAD_ERROR_IT: Record<string, string> = {
  file_too_large: 'Il file è troppo grande (massimo 40 MB).',
  invalid_file_type: 'Questo tipo di file non è supportato.',
  upload_rejected: 'Il caricamento è stato rifiutato.',
  upload_changed: 'Il file è cambiato durante il caricamento. Riselezionalo e riprova.',
  upload_not_found: 'Il caricamento è scaduto. Riseleziona il file.',
  copy_unavailable: 'Archiviazione momentaneamente occupata. Riprova tra un minuto.',
  unauthorized: 'Devi accedere per caricare un brano.',
  private_storage_unavailable: 'Il caricamento non è disponibile al momento.',
  network: 'Caricamento non riuscito. Controlla la connessione e riprova.',
  unknown: 'Caricamento non riuscito. Riprova.',
};

/** Messaggio italiano per un codice di errore del caricamento file. */
export function uploadErrorMessageIt(code: string): string {
  return UPLOAD_ERROR_IT[code] ?? 'Caricamento non riuscito. Riprova.';
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

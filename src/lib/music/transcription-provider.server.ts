// @polsia:user-owned — «Solco AI»: il motore di trascrizione dei testi dei brani in evidenza.
// Il modello è Whisper large-v3 a pesi aperti, eseguito dal servizio scelto con le variabili di
// Vercel; l'audio non va a OpenAI a meno che LYRICS_AI_PROVIDER non valga "openai".
//
// - Predefinito: Groq (GROQ_API_KEY), modello whisper-large-v3 (GROQ_WHISPER_MODEL può scegliere
//   whisper-large-v3-turbo). API compatibile con quella di OpenAI: stessa richiesta multipart e
//   stessa risposta verbose_json (whisper.server.ts), file fino a 25 MB.
// - LYRICS_AI_PROVIDER=openai: OpenAI whisper-1 con OPENAI_API_KEY, solo su scelta esplicita.
// Senza la chiave del motore scelto la trascrizione è spenta e la pagina admin lo dice.
// Nessuna dipendenza pesante: lo importano anche il monitoraggio e la diagnosi admin.
import 'server-only';
import { SOLCO_AI_NAME, TRANSCRIPTION_MAX_AUDIO_BYTES } from '@/lib/contracts/lyrics-transcription';

type EnvLike = Record<string, string | undefined>;

export type TranscriptionProviderId = 'groq' | 'openai';

/** Dove e come si manda l'audio, senza la chiave: condiviso da trascrizione, prova e messaggi. */
export type TranscriptionTarget = {
  id: TranscriptionProviderId;
  /** Nome del servizio nei messaggi d'errore («Groq», «OpenAI»). */
  vendor: string;
  endpoint: string;
  model: string;
  /** Variabile di Vercel con la chiave. */
  envName: string;
  /** Dove si controllano piano e crediti (solo l'host, per i messaggi). */
  billingHost: string;
  /** Dimensione massima del file accettata dal servizio. */
  maxAudioBytes: number;
};

export type TranscriptionProvider = TranscriptionTarget & {
  /** Nome mostrato all'amministratore («Solco AI (Groq)», «OpenAI»). */
  label: string;
  apiKey: string;
};

export const GROQ_TRANSCRIPTION_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
export const GROQ_DEFAULT_MODEL = 'whisper-large-v3';
export const GROQ_MODELS = ['whisper-large-v3', 'whisper-large-v3-turbo'] as const;
export const OPENAI_TRANSCRIPTION_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
export const OPENAI_MODEL = 'whisper-1';
/** Variabile che sceglie il motore: assente o "groq" = Solco AI su Groq; "openai" = OpenAI. */
export const TRANSCRIPTION_PROVIDER_ENV = 'LYRICS_AI_PROVIDER';

export const GROQ_TARGET: TranscriptionTarget = {
  id: 'groq',
  vendor: 'Groq',
  endpoint: GROQ_TRANSCRIPTION_ENDPOINT,
  model: GROQ_DEFAULT_MODEL,
  envName: 'GROQ_API_KEY',
  billingHost: 'console.groq.com',
  maxAudioBytes: TRANSCRIPTION_MAX_AUDIO_BYTES,
};

export const OPENAI_TARGET: TranscriptionTarget = {
  id: 'openai',
  vendor: 'OpenAI',
  endpoint: OPENAI_TRANSCRIPTION_ENDPOINT,
  model: OPENAI_MODEL,
  envName: 'OPENAI_API_KEY',
  billingHost: 'platform.openai.com',
  maxAudioBytes: TRANSCRIPTION_MAX_AUDIO_BYTES,
};

function wantsOpenAi(env: EnvLike): boolean {
  return env[TRANSCRIPTION_PROVIDER_ENV]?.trim().toLowerCase() === 'openai';
}

function groqModel(value: string | undefined): string {
  const model = value?.trim();
  return model && (GROQ_MODELS as readonly string[]).includes(model) ? model : GROQ_DEFAULT_MODEL;
}

/** La variabile di Vercel che deve contenere la chiave del motore scelto. */
export function transcriptionKeyEnvName(env: EnvLike = process.env): string {
  return wantsOpenAi(env) ? OPENAI_TARGET.envName : GROQ_TARGET.envName;
}

/** Il motore configurato, o null se manca la chiave. Mai loggare né restituire `apiKey`. */
export function transcriptionProvider(env: EnvLike = process.env): TranscriptionProvider | null {
  if (wantsOpenAi(env)) {
    const apiKey = env.OPENAI_API_KEY?.trim();
    return apiKey ? { ...OPENAI_TARGET, label: OPENAI_TARGET.vendor, apiKey } : null;
  }
  const apiKey = env.GROQ_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    ...GROQ_TARGET,
    model: groqModel(env.GROQ_WHISPER_MODEL),
    label: `${SOLCO_AI_NAME} (Groq)`,
    apiKey,
  };
}

/** True se la trascrizione dei testi si può usare (chiave del motore presente). */
export function isTranscriptionConfigured(env?: EnvLike): boolean {
  return transcriptionProvider(env) !== null;
}

/** Descrizione senza segreti del motore: «Solco AI (Groq · whisper-large-v3)», «OpenAI (whisper-1)». */
export function transcriptionEngineLabel(
  provider: Pick<TranscriptionProvider, 'label' | 'model'>,
): string {
  return provider.label.endsWith(')')
    ? `${provider.label.slice(0, -1)} · ${provider.model})`
    : `${provider.label} (${provider.model})`;
}

/** Il motore attivo descritto per la pagina admin, o undefined se la trascrizione è spenta. */
export function activeTranscriptionEngine(env?: EnvLike): string | undefined {
  const provider = transcriptionProvider(env);
  return provider ? transcriptionEngineLabel(provider) : undefined;
}

/** Prefisso con cui iniziano le chiavi del servizio (Groq «gsk_», OpenAI «sk-»). */
const KEY_PREFIX: Record<TranscriptionProviderId, string> = { groq: 'gsk_', openai: 'sk-' };
/** Le chiavi Groq sono "gsk_" più 52 caratteri. */
const GROQ_KEY_LENGTH = 56;
/** Caratteri ammessi in una chiave: lettere, cifre, trattino e trattino basso. */
const KEY_CHARS = /^[A-Za-z0-9_-]+$/;

/**
 * Com'è fatta la chiave SENZA rivelarla, per capire un rifiuto del servizio: lunghezza, prefisso
 * atteso e caratteri estranei (spazi, a capo, virgolette, asterischi o puntini della versione
 * nascosta copiata dalla lista delle chiavi). Es. «56 caratteri, inizia con gsk_» oppure
 * «22 caratteri, contiene caratteri non ammessi (asterischi, puntini o simboli)».
 */
export function apiKeyShape(provider: Pick<TranscriptionProvider, 'id' | 'apiKey'>): string {
  const key = provider.apiKey;
  const prefix = KEY_PREFIX[provider.id];
  const problems: string[] = [];
  if (/\s/.test(key)) problems.push('contiene spazi o a capo');
  if (/["'`«»]/.test(key)) problems.push('contiene virgolette');
  if (!KEY_CHARS.test(key.replace(/[\s"'`«»]/g, ''))) {
    problems.push(
      'contiene caratteri non ammessi (asterischi, puntini o simboli: forse è la versione nascosta mostrata nella lista, non la chiave intera)',
    );
  }
  if (!key.startsWith(prefix)) problems.push(`non inizia con ${prefix}`);
  if (provider.id === 'groq' && key.length !== GROQ_KEY_LENGTH) {
    problems.push(`lunghezza insolita (le chiavi Groq hanno ${GROQ_KEY_LENGTH} caratteri)`);
  }
  const length = `${key.length} caratteri`;
  return problems.length > 0
    ? `${length}, ${problems.join(', ')}`
    : `${length}, inizia con ${prefix}`;
}

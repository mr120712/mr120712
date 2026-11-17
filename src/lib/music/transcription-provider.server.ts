// @polsia:user-owned — «Solco AI»: i motori di trascrizione dei testi dei brani in evidenza. Solco AI
// non dipende da un solo fornitore: ogni servizio con la sua chiave su Vercel è un motore, e la
// trascrizione prova i motori configurati nell'ordine scelto, passando al successivo se uno rifiuta
// la chiave, non ha crediti, limita le richieste, è giù o non risponde
// (transcription-engines.server.ts). Il risultato dice quale motore ha trascritto.
//
// Motori (modello, variabile con la chiave, protocollo):
// - groq: Whisper large-v3 a pesi aperti su Groq (GROQ_API_KEY; GROQ_WHISPER_MODEL può scegliere
//   whisper-large-v3-turbo). API in stile OpenAI (whisper.server.ts). Veloce ed economico.
// - deepgram: nova-3 (DEEPGRAM_API_KEY), parole con tempo, molto veloce (deepgram.server.ts).
// - elevenlabs: Scribe v1 (ELEVENLABS_API_KEY), parole con tempo (elevenlabs.server.ts).
// - openai: whisper-1 (OPENAI_API_KEY), API in stile OpenAI.
// - fireworks: whisper-v3 (FIREWORKS_API_KEY), API in stile OpenAI.
// - mistral: voxtral-mini-latest (MISTRAL_API_KEY), API in stile OpenAI, solo tempi dei segmenti.
// - cloudflare: whisper-large-v3-turbo su Workers AI (CLOUDFLARE_API_TOKEN; CLOUDFLARE_ACCOUNT_ID solo
//   se il token vede più account: altrimenti l'account si scopre col token), con una quota gratuita
//   (cloudflare-ai.server.ts).
// Ordine: LYRICS_AI_ENGINES ("deepgram,groq,openai": SOLO quelli elencati, in quell'ordine),
// altrimenti DEFAULT_ENGINE_ORDER; LYRICS_AI_PROVIDER=openai (variabile storica) mette OpenAI per
// primo. Senza nessuna chiave la trascrizione è spenta e la pagina admin lo dice.
// Hedging: LYRICS_AI_HEDGE_MS (predefinito 20000) è il tempo dopo il quale, se il motore in corso non
// ha ancora risposto, parte anche il successivo; vince il primo che riesce ("0"/"off" = uno alla volta).
// Nessuna dipendenza pesante: lo importano anche il monitoraggio e la diagnosi admin. Mai loggare né
// restituire `apiKey`.
import 'server-only';
import { SOLCO_AI_NAME, TRANSCRIPTION_MAX_AUDIO_BYTES } from '@/lib/contracts/lyrics-transcription';

type EnvLike = Record<string, string | undefined>;

export type TranscriptionProviderId =
  | 'groq'
  | 'deepgram'
  | 'elevenlabs'
  | 'openai'
  | 'fireworks'
  | 'mistral'
  | 'cloudflare';

/** Come si parla col servizio: in stile OpenAI (multipart + verbose_json) o con un protocollo suo. */
export type TranscriptionProtocol = 'openai' | 'deepgram' | 'elevenlabs' | 'cloudflare';

/** Dove e come si manda l'audio, senza la chiave: condiviso da trascrizione, prova e messaggi. */
export type TranscriptionTarget = {
  id: TranscriptionProviderId;
  /** Nome del servizio nei messaggi d'errore («Groq», «Deepgram»…). */
  vendor: string;
  endpoint: string;
  model: string;
  /** Variabile di Vercel con la chiave. */
  envName: string;
  /** Dove si controllano piano e crediti (solo l'host, per i messaggi). */
  billingHost: string;
  /** Dimensione massima del file accettata dal servizio. */
  maxAudioBytes: number;
  protocol: TranscriptionProtocol;
  /** true = il servizio dà i tempi delle singole parole (karaoke nel player). */
  wordTimestamps: boolean;
  /** Prefisso con cui iniziano le sue chiavi ('' = nessuno noto), per la diagnosi senza rivelarle. */
  keyPrefix: string;
  /** Lunghezza esatta delle sue chiavi, se nota (Groq: 56). */
  keyLength: number | null;
};

export type TranscriptionProvider = TranscriptionTarget & {
  /** Nome mostrato all'amministratore («Solco AI (Groq)», «Deepgram»). */
  label: string;
  apiKey: string;
  /** Solo Cloudflare: l'account su cui gira Workers AI (CLOUDFLARE_ACCOUNT_ID); assente = si scopre col token. */
  accountId?: string;
};

export const GROQ_TRANSCRIPTION_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
export const GROQ_DEFAULT_MODEL = 'whisper-large-v3';
export const GROQ_MODELS = ['whisper-large-v3', 'whisper-large-v3-turbo'] as const;
export const OPENAI_TRANSCRIPTION_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
export const OPENAI_MODEL = 'whisper-1';
export const FIREWORKS_TRANSCRIPTION_ENDPOINT =
  'https://api.fireworks.ai/inference/v1/audio/transcriptions';
export const FIREWORKS_MODEL = 'whisper-v3';
export const MISTRAL_TRANSCRIPTION_ENDPOINT = 'https://api.mistral.ai/v1/audio/transcriptions';
export const MISTRAL_MODEL = 'voxtral-mini-latest';
export const DEEPGRAM_TRANSCRIPTION_ENDPOINT = 'https://api.deepgram.com/v1/listen';
export const DEEPGRAM_MODEL = 'nova-3';
export const ELEVENLABS_TRANSCRIPTION_ENDPOINT = 'https://api.elevenlabs.io/v1/speech-to-text';
export const ELEVENLABS_MODEL = 'scribe_v1';
export const CLOUDFLARE_MODEL = '@cf/openai/whisper-large-v3-turbo';
/** Variabile con l'account Cloudflare (facoltativa: serve solo se il token vede più account). */
export const CLOUDFLARE_ACCOUNT_ENV = 'CLOUDFLARE_ACCOUNT_ID';
/** Variabile storica: "openai" mette OpenAI per primo. */
export const TRANSCRIPTION_PROVIDER_ENV = 'LYRICS_AI_PROVIDER';
/** Elenco dei motori da usare, in ordine (es. "deepgram,groq"): solo quelli elencati. */
export const TRANSCRIPTION_ENGINES_ENV = 'LYRICS_AI_ENGINES';
/**
 * Passaggio «in parallelo» (hedging): dopo quanti millisecondi senza risposta dal motore in corso
 * parte anche il successivo ("0" oppure "off" = uno alla volta, solo dopo un errore).
 */
export const TRANSCRIPTION_HEDGE_ENV = 'LYRICS_AI_HEDGE_MS';
/** Soglia predefinita dell'hedging: un motore che tace da 20 s è quasi sempre in difficoltà. */
export const DEFAULT_HEDGE_MS = 20_000;
export const MIN_HEDGE_MS = 3_000;
export const MAX_HEDGE_MS = 90_000;

/**
 * La soglia dell'hedging da LYRICS_AI_HEDGE_MS (3-90 s), DEFAULT_HEDGE_MS se la variabile manca o
 * non è un numero; undefined ("0", "off", "no", "false") = un motore alla volta.
 */
export function transcriptionHedgeMs(env: EnvLike = process.env): number | undefined {
  const raw = env[TRANSCRIPTION_HEDGE_ENV]?.trim().toLowerCase() ?? '';
  if (raw === '') return DEFAULT_HEDGE_MS;
  if (raw === '0' || raw === 'off' || raw === 'no' || raw === 'false') return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return DEFAULT_HEDGE_MS;
  return Math.min(MAX_HEDGE_MS, Math.max(MIN_HEDGE_MS, value));
}

/** L'endpoint di Workers AI per l'account indicato. */
export function cloudflareEndpoint(accountId: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${CLOUDFLARE_MODEL}`;
}

const maxAudioBytes = TRANSCRIPTION_MAX_AUDIO_BYTES;

export const GROQ_TARGET: TranscriptionTarget = {
  id: 'groq',
  vendor: 'Groq',
  endpoint: GROQ_TRANSCRIPTION_ENDPOINT,
  model: GROQ_DEFAULT_MODEL,
  envName: 'GROQ_API_KEY',
  billingHost: 'console.groq.com',
  maxAudioBytes,
  protocol: 'openai',
  wordTimestamps: true,
  keyPrefix: 'gsk_',
  keyLength: 56,
};

export const DEEPGRAM_TARGET: TranscriptionTarget = {
  id: 'deepgram',
  vendor: 'Deepgram',
  endpoint: DEEPGRAM_TRANSCRIPTION_ENDPOINT,
  model: DEEPGRAM_MODEL,
  envName: 'DEEPGRAM_API_KEY',
  billingHost: 'console.deepgram.com',
  maxAudioBytes,
  protocol: 'deepgram',
  wordTimestamps: true,
  keyPrefix: '',
  keyLength: null,
};

export const ELEVENLABS_TARGET: TranscriptionTarget = {
  id: 'elevenlabs',
  vendor: 'ElevenLabs',
  endpoint: ELEVENLABS_TRANSCRIPTION_ENDPOINT,
  model: ELEVENLABS_MODEL,
  envName: 'ELEVENLABS_API_KEY',
  billingHost: 'elevenlabs.io',
  maxAudioBytes,
  protocol: 'elevenlabs',
  wordTimestamps: true,
  keyPrefix: '',
  keyLength: null,
};

export const OPENAI_TARGET: TranscriptionTarget = {
  id: 'openai',
  vendor: 'OpenAI',
  endpoint: OPENAI_TRANSCRIPTION_ENDPOINT,
  model: OPENAI_MODEL,
  envName: 'OPENAI_API_KEY',
  billingHost: 'platform.openai.com',
  maxAudioBytes,
  protocol: 'openai',
  wordTimestamps: true,
  keyPrefix: 'sk-',
  keyLength: null,
};

export const FIREWORKS_TARGET: TranscriptionTarget = {
  id: 'fireworks',
  vendor: 'Fireworks',
  endpoint: FIREWORKS_TRANSCRIPTION_ENDPOINT,
  model: FIREWORKS_MODEL,
  envName: 'FIREWORKS_API_KEY',
  billingHost: 'fireworks.ai',
  maxAudioBytes,
  protocol: 'openai',
  wordTimestamps: true,
  keyPrefix: 'fw_',
  keyLength: null,
};

export const MISTRAL_TARGET: TranscriptionTarget = {
  id: 'mistral',
  vendor: 'Mistral',
  endpoint: MISTRAL_TRANSCRIPTION_ENDPOINT,
  model: MISTRAL_MODEL,
  envName: 'MISTRAL_API_KEY',
  billingHost: 'console.mistral.ai',
  maxAudioBytes,
  protocol: 'openai',
  // Voxtral dà i tempi dei segmenti, non delle parole: la bozza esce riga per riga.
  wordTimestamps: false,
  keyPrefix: '',
  keyLength: null,
};

export const CLOUDFLARE_TARGET: TranscriptionTarget = {
  id: 'cloudflare',
  vendor: 'Cloudflare',
  // Il vero endpoint dipende dall'account (cloudflareEndpoint).
  endpoint: cloudflareEndpoint('{account}'),
  model: CLOUDFLARE_MODEL,
  envName: 'CLOUDFLARE_API_TOKEN',
  billingHost: 'dash.cloudflare.com',
  maxAudioBytes,
  protocol: 'cloudflare',
  wordTimestamps: true,
  keyPrefix: '',
  keyLength: null,
};

export const TRANSCRIPTION_TARGETS: Readonly<Record<TranscriptionProviderId, TranscriptionTarget>> =
  {
    groq: GROQ_TARGET,
    deepgram: DEEPGRAM_TARGET,
    elevenlabs: ELEVENLABS_TARGET,
    openai: OPENAI_TARGET,
    fireworks: FIREWORKS_TARGET,
    mistral: MISTRAL_TARGET,
    cloudflare: CLOUDFLARE_TARGET,
  };

/** Ordine predefinito: prima i motori veloci ed economici con le parole con tempo. */
export const DEFAULT_ENGINE_ORDER: readonly TranscriptionProviderId[] = [
  'groq',
  'deepgram',
  'elevenlabs',
  'openai',
  'fireworks',
  'mistral',
  'cloudflare',
];

/** Le variabili di Vercel che accendono un motore, nell'ordine predefinito. */
export const TRANSCRIPTION_KEY_ENV_NAMES: readonly string[] = DEFAULT_ENGINE_ORDER.map(
  (id) => TRANSCRIPTION_TARGETS[id].envName,
);

function isProviderId(value: string): value is TranscriptionProviderId {
  return Object.hasOwn(TRANSCRIPTION_TARGETS, value);
}

function wantsOpenAi(env: EnvLike): boolean {
  return env[TRANSCRIPTION_PROVIDER_ENV]?.trim().toLowerCase() === 'openai';
}

function groqModel(value: string | undefined): string {
  const model = value?.trim();
  return model && (GROQ_MODELS as readonly string[]).includes(model) ? model : GROQ_DEFAULT_MODEL;
}

/**
 * L'ordine dei motori: LYRICS_AI_ENGINES se elenca almeno un motore noto (solo quelli, in
 * quell'ordine, senza doppioni), altrimenti l'ordine predefinito, con OpenAI per primo se
 * LYRICS_AI_PROVIDER vale "openai".
 */
export function transcriptionEngineOrder(env: EnvLike = process.env): TranscriptionProviderId[] {
  const listed = (env[TRANSCRIPTION_ENGINES_ENV] ?? '')
    .split(/[\s,;]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(isProviderId);
  const unique = [...new Set(listed)];
  if (unique.length > 0) return unique;
  if (wantsOpenAi(env)) return ['openai', ...DEFAULT_ENGINE_ORDER.filter((id) => id !== 'openai')];
  return [...DEFAULT_ENGINE_ORDER];
}

/** Account Cloudflare: identificatori alfanumerici (di solito 32 caratteri esadecimali). */
const CLOUDFLARE_ACCOUNT_ID = /^[A-Za-z0-9]{8,64}$/;

/** Il motore `id` se la sua chiave è su Vercel, altrimenti null. */
export function transcriptionProviderFor(
  id: TranscriptionProviderId,
  env: EnvLike = process.env,
): TranscriptionProvider | null {
  const target = TRANSCRIPTION_TARGETS[id];
  const apiKey = env[target.envName]?.trim();
  if (!apiKey) return null;
  if (id === 'groq') {
    return {
      ...target,
      model: groqModel(env.GROQ_WHISPER_MODEL),
      label: `${SOLCO_AI_NAME} (Groq)`,
      apiKey,
    };
  }
  if (id === 'cloudflare') {
    // L'account è facoltativo: senza, il motore lo chiede a Cloudflare col token (il primo account a
    // cui il token ha accesso) e lo ricorda per il processo (cloudflare-ai.server.ts).
    const accountId = env[CLOUDFLARE_ACCOUNT_ENV]?.trim();
    const known = accountId && CLOUDFLARE_ACCOUNT_ID.test(accountId) ? accountId : undefined;
    return {
      ...target,
      endpoint: known ? cloudflareEndpoint(known) : '',
      label: target.vendor,
      apiKey,
      ...(known ? { accountId: known } : {}),
    };
  }
  return { ...target, label: target.vendor, apiKey };
}

/** I motori configurati, nell'ordine in cui la trascrizione li prova. Mai loggare `apiKey`. */
export function configuredTranscriptionProviders(
  env: EnvLike = process.env,
): TranscriptionProvider[] {
  const providers: TranscriptionProvider[] = [];
  for (const id of transcriptionEngineOrder(env)) {
    const provider = transcriptionProviderFor(id, env);
    if (provider) providers.push(provider);
  }
  return providers;
}

/** Il primo motore configurato (quello che risponde per primo), o null se nessuno ha la chiave. */
export function transcriptionProvider(env: EnvLike = process.env): TranscriptionProvider | null {
  return configuredTranscriptionProviders(env)[0] ?? null;
}

/** La variabile di Vercel del motore in testa all'ordine (quella da compilare per prima). */
export function transcriptionKeyEnvName(env: EnvLike = process.env): string {
  const [first] = transcriptionEngineOrder(env);
  return TRANSCRIPTION_TARGETS[first ?? 'groq'].envName;
}

/** Le variabili di Vercel dei motori nell'ordine attivo (per dire quali chiavi accendono Solco AI). */
export function transcriptionKeyEnvNames(env: EnvLike = process.env): string[] {
  return transcriptionEngineOrder(env).map((id) => TRANSCRIPTION_TARGETS[id].envName);
}

/** True se la trascrizione dei testi si può usare (almeno un motore con la chiave). */
export function isTranscriptionConfigured(env?: EnvLike): boolean {
  return configuredTranscriptionProviders(env).length > 0;
}

/** Descrizione senza segreti del motore: «Solco AI (Groq · whisper-large-v3)», «Deepgram (nova-3)». */
export function transcriptionEngineLabel(
  provider: Pick<TranscriptionProvider, 'label' | 'model'>,
): string {
  return provider.label.endsWith(')')
    ? `${provider.label.slice(0, -1)} · ${provider.model})`
    : `${provider.label} (${provider.model})`;
}

/**
 * I motori attivi descritti per la pagina admin, o undefined se la trascrizione è spenta: il primo
 * e, dopo «riserva:», gli altri nell'ordine in cui subentrano.
 */
export function activeTranscriptionEngine(env?: EnvLike): string | undefined {
  const [first, ...reserves] = configuredTranscriptionProviders(env);
  if (!first) return undefined;
  const head = transcriptionEngineLabel(first);
  if (reserves.length === 0) return head;
  return `${head}; riserva: ${reserves.map(transcriptionEngineLabel).join(', ')}`;
}

/** L'etichetta del motore che ha prodotto una trascrizione conservata, dal suo modello. */
export function engineLabelForModel(model: string | null | undefined): string | undefined {
  if (!model) return undefined;
  if ((GROQ_MODELS as readonly string[]).includes(model)) {
    return transcriptionEngineLabel({ label: `${SOLCO_AI_NAME} (Groq)`, model });
  }
  const target = Object.values(TRANSCRIPTION_TARGETS).find((item) => item.model === model);
  return target ? transcriptionEngineLabel({ label: target.vendor, model }) : undefined;
}

/** Caratteri ammessi in una chiave: lettere, cifre, trattino e trattino basso. */
const KEY_CHARS = /^[A-Za-z0-9_-]+$/;

/**
 * Com'è fatta la chiave SENZA rivelarla, per capire un rifiuto del servizio: lunghezza, prefisso
 * atteso e caratteri estranei (spazi, a capo, virgolette, asterischi o puntini della versione
 * nascosta copiata dalla lista delle chiavi). Es. «56 caratteri, inizia con gsk_» oppure
 * «22 caratteri, contiene caratteri non ammessi (asterischi, puntini o simboli)».
 */
export function apiKeyShape(provider: Pick<TranscriptionProvider, 'id' | 'apiKey'>): string {
  const target = TRANSCRIPTION_TARGETS[provider.id];
  const key = provider.apiKey;
  const problems: string[] = [];
  if (/\s/.test(key)) problems.push('contiene spazi o a capo');
  if (/["'`«»]/.test(key)) problems.push('contiene virgolette');
  if (!KEY_CHARS.test(key.replace(/[\s"'`«»]/g, ''))) {
    problems.push(
      'contiene caratteri non ammessi (asterischi, puntini o simboli: forse è la versione nascosta mostrata nella lista, non la chiave intera)',
    );
  }
  if (target.keyPrefix && !key.startsWith(target.keyPrefix)) {
    problems.push(`non inizia con ${target.keyPrefix}`);
  }
  if (target.keyLength !== null && key.length !== target.keyLength) {
    problems.push(
      `lunghezza insolita (le chiavi ${target.vendor} hanno ${target.keyLength} caratteri)`,
    );
  }
  const length = `${key.length} caratteri`;
  if (problems.length > 0) return `${length}, ${problems.join(', ')}`;
  return target.keyPrefix ? `${length}, inizia con ${target.keyPrefix}` : length;
}

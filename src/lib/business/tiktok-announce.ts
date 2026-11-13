// @polsia:user-owned — regole pure del generatore di annunci TikTok: pulizia e limiti dell'output
// dell'IA (funzioni testabili, senza 'server-only' né l'SDK, così il test non carica l'ambiente).
import type { TikTokAnnouncement } from '@/lib/contracts/tiktok-announce';

/** Forma grezza che arriva da Claude (già JSON, ma da ripulire e limitare). */
export type RawTikTokAnnouncement = {
  hook?: unknown;
  caption?: unknown;
  hashtags?: unknown;
  script?: { durationSeconds?: unknown; beats?: unknown; cta?: unknown };
  soundIdea?: unknown;
  altText?: unknown;
};

// La didascalia è limitata a 200: è anche il limite del campo didascalia del clip TikTok
// (TikTokClipCreateSchema.caption), così "Usa come didascalia" produce sempre un valore salvabile.
const STR = { hook: 140, caption: 200, cta: 140, soundIdea: 240, altText: 320, beat: 160, at: 24 };
const MAX_HASHTAGS = 8;
const MAX_BEATS = 8;
// Limite generoso sul numero di scene grezze da elaborare prima di scartare le vuote e tagliare a 8.
const MAX_RAW_BEATS = 40;
const MIN_SECONDS = 10;
const MAX_SECONDS = 60;
const DEFAULT_SECONDS = 30;

function clamp(value: unknown, max: number): string {
  return (typeof value === 'string' ? value : '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** "#Techno 2024!" → "#techno2024": un solo cancelletto, lettere/numeri/underscore, minuscolo. */
export function normalizeHashtag(raw: unknown): string {
  const body = (typeof raw === 'string' ? raw : '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/^#+/, '')
    .replace(/[^\p{L}\p{N}_]+/gu, '')
    .toLocaleLowerCase('it-IT')
    .slice(0, 30);
  return body ? `#${body}` : '';
}

/** Tiene solo ciò che è pubblicabile: lunghezze contenute, hashtag puliti e unici, durata 10-60s. */
export function sanitizeAnnouncement(raw: RawTikTokAnnouncement): TikTokAnnouncement {
  const seen = new Set<string>();
  const hashtags: string[] = [];
  for (const tag of Array.isArray(raw.hashtags) ? raw.hashtags : []) {
    const clean = normalizeHashtag(tag);
    if (clean.length < 2 || seen.has(clean)) continue;
    seen.add(clean);
    hashtags.push(clean);
    if (hashtags.length === MAX_HASHTAGS) break;
  }

  const rawBeats = Array.isArray(raw.script?.beats) ? raw.script.beats : [];
  // Scarta le scene vuote PRIMA di tagliare a 8, così una scena vuota in testa non consuma uno slot
  // e non spinge fuori una scena valida.
  const beats = rawBeats
    .slice(0, MAX_RAW_BEATS)
    .map((beat: unknown) => {
      const value = (beat ?? {}) as Record<string, unknown>;
      return {
        at: clamp(value.at, STR.at),
        onScreen: clamp(value.onScreen, STR.beat),
        voiceover: clamp(value.voiceover, STR.beat),
        visual: clamp(value.visual, STR.beat),
      };
    })
    .filter((beat) => beat.onScreen || beat.voiceover || beat.visual)
    .slice(0, MAX_BEATS);

  const rawDuration = Number(raw.script?.durationSeconds);
  const durationSeconds = Number.isFinite(rawDuration)
    ? Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Math.round(rawDuration)))
    : DEFAULT_SECONDS;

  return {
    hook: clamp(raw.hook, STR.hook),
    caption: clamp(raw.caption, STR.caption),
    hashtags,
    script: { durationSeconds, beats, cta: clamp(raw.script?.cta, STR.cta) },
    soundIdea: clamp(raw.soundIdea, STR.soundIdea),
    altText: clamp(raw.altText, STR.altText),
  };
}

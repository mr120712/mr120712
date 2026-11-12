// @polsia:user-owned — playlist condivise: formato del link pubblico (/playlist/<shareId>) e nome
// del proprietario mostrato a chi apre il link. Nessuna dipendenza server: lo usano anche le pagine.

/** 16 byte casuali in base64url senza padding: sempre 22 caratteri [A-Za-z0-9_-]. */
export const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** Minuscolo: compare sempre dentro una frase («di un ascoltatore Solco»). */
export const SHARED_PLAYLIST_OWNER_FALLBACK = 'un ascoltatore Solco';
/** In UTF-16 units, the unit zod's .max() counts in SharedPlaylistSchema. */
export const SHARED_PLAYLIST_OWNER_MAX_LENGTH = 30;

export function isShareId(value: unknown): value is string {
  return typeof value === 'string' && SHARE_ID_PATTERN.test(value);
}

export function sharedPlaylistPath(shareId: string) {
  return `/playlist/${encodeURIComponent(shareId)}`;
}

/**
 * Anteprima social (PNG 1200×630): un solo indirizzo canonico, senza query string. L’estensione
 * .png la fa trattare come un file statico (crawler dei link, gate anti-attacco).
 */
export function sharedPlaylistImagePath(shareId: string) {
  return `${sharedPlaylistPath(shareId)}/anteprima.png`;
}

/** Whole graphemes (emoji, flags, accented letters); code points where Intl.Segmenter is missing. */
function graphemes(text: string): string[] {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter('it', { granularity: 'grapheme' });
    return Array.from(segmenter.segment(text), (part) => part.segment);
  }
  return Array.from(text);
}

/** At most `max` UTF-16 units, cut only between whole graphemes (never half an emoji). */
function clipToUtf16Length(text: string, max: number) {
  let clipped = '';
  for (const grapheme of graphemes(text)) {
    if (clipped.length + grapheme.length > max) break;
    clipped += grapheme;
  }
  return clipped;
}

/**
 * La prima parola del nome dell'account, mai l'email: al massimo 30 unità UTF-16 (quelle che
 * conta il contratto), tagliate tra caratteri interi. Un nome che sembra un indirizzo email, vuoto,
 * senza nulla di visibile o fatto di un solo carattere troppo lungo diventa un'etichetta generica.
 */
export function sharedPlaylistOwnerName(name: string | null | undefined): string {
  // Control and bidi characters become spaces; the joiners U+200C/U+200D stay, because they are
  // part of words (Persian, Indic scripts) and of emoji such as \ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67.
  const cleaned = (name ?? '')
    .normalize('NFC')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strip control characters.
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, ' ')
    .trim();
  const first = cleaned.split(/\s+/)[0] ?? '';
  if (!first || first.includes('@')) return SHARED_PLAYLIST_OWNER_FALLBACK;
  const owner = clipToUtf16Length(first, SHARED_PLAYLIST_OWNER_MAX_LENGTH);
  return /[\p{L}\p{N}\p{S}]/u.test(owner) ? owner : SHARED_PLAYLIST_OWNER_FALLBACK;
}

/**
 * A name (playlist, owner) placed inside an Italian sentence shown as plain text (toast, share
 * text): FSI…PDI keep a right-to-left or mixed-direction name from reordering the quotes and
 * punctuation around it. In JSX use <bdi> instead.
 */
export function isolateName(name: string) {
  return `\u2068${name}\u2069`;
}

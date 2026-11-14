// @polsia:user-owned — playlist condivise: formato del link pubblico (/playlist/<shareId>) e nome
// del proprietario mostrato a chi apre il link. Nessuna dipendenza server: lo usano anche le pagine.

/** 16 byte casuali in base64url senza padding: sempre 22 caratteri [A-Za-z0-9_-]. */
export const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** Minuscolo: compare sempre dentro una frase («di un ascoltatore Solco»). */
export const SHARED_PLAYLIST_OWNER_FALLBACK = 'un ascoltatore Solco';
/** In UTF-16 units, the unit zod's .max() counts in SharedPlaylistSchema. */
export const SHARED_PLAYLIST_OWNER_MAX_LENGTH = 30;

/**
 * Titolo (og:title, twitter:title), descrizione e testo alternativo della scheda di una playlist
 * condivisa: la pagina (playlist/[shareId]/page.tsx) e l'anteprima per i bot in modalità attacco
 * (uam-preview.ts) usano gli stessi, così lo stesso link ha la stessa anteprima. Unica eccezione:
 * se il proprietario ha scritto una descrizione, la pagina la usa al posto di quella generica
 * (l'anteprima in modalità attacco non legge il database e resta generica).
 */
export const SHARED_PLAYLIST_TITLE = 'Playlist condivisa';
export const SHARED_PLAYLIST_DESCRIPTION =
  'Una playlist condivisa su Solco: ascoltala gratis e salvala nella tua Libreria.';
export const SHARED_PLAYLIST_IMAGE_ALT = 'Playlist condivisa su Solco';

export function isShareId(value: unknown): value is string {
  return typeof value === 'string' && SHARE_ID_PATTERN.test(value);
}

export function sharedPlaylistPath(shareId: string) {
  return `/playlist/${encodeURIComponent(shareId)}`;
}

/**
 * Anteprima social (JPEG 1200×630): un solo indirizzo canonico, senza query string. L’estensione
 * .jpg la fa trattare come un file statico (crawler dei link, gate anti-attacco). Il vecchio
 * indirizzo .png reindirizza qui.
 */
export function sharedPlaylistImagePath(shareId: string) {
  return `${sharedPlaylistPath(shareId)}/anteprima.jpg`;
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
 * Il testo intero se sta in `max` unità UTF-16; altrimenti tagliato tra caratteri interi (mai
 * mezza emoji) con «…» finale, sempre entro `max`.
 */
export function clipWithEllipsis(text: string, max: number) {
  if (text.length <= max) return text;
  return `${clipToUtf16Length(text, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * Descrizione di una playlist: al massimo 300 unità UTF-16 (quelle che conta zod .max e
 * l'attributo maxLength della textarea), misurate sul testo già ripulito.
 */
export const PLAYLIST_DESCRIPTION_MAX_LENGTH = 300;
/**
 * Testo grezzo accettato prima della pulizia: qualche spazio o riga vuota in più non deve far
 * fallire un testo che, ripulito, sta nei 300 caratteri. Il corpo della richiesta resta sotto 4 KB.
 */
export const PLAYLIST_DESCRIPTION_RAW_MAX_LENGTH = 1000;
/** og:description di una playlist condivisa: le anteprime dei link ne mostrano circa tanto. */
export const SHARED_PLAYLIST_META_DESCRIPTION_MAX_LENGTH = 160;

/**
 * Caratteri che non si vedono: tutti gli \u00abignorabili\u00bb Unicode (trattino morbido, riempitivi
 * Hangul, selettori mongoli, caratteri tag U+E0000\u2013E007F che possono nascondere testo ASCII\u2026) e la
 * cella braille vuota U+2800. Il primo gruppo cattura le sole sequenze di tag legittime, le
 * bandiere di Inghilterra, Scozia e Galles (\ud83c\udff4 + tag + fine tag), che restano intere.
 */
const HIDDEN_CHARACTERS =
  /(\u{1F3F4}\u{E0067}\u{E0062}(?:\u{E0065}\u{E006E}\u{E0067}|\u{E0073}\u{E0063}\u{E0074}|\u{E0077}\u{E006C}\u{E0073})\u{E007F})|[\p{Default_Ignorable_Code_Point}\u2800]/gu;
/** Ignorabili che fanno parte del testo: joiner (persiano, indiano, emoji) e selettori di variante. */
function isKeptIgnorable(character: string) {
  const code = character.codePointAt(0) ?? 0;
  return (
    code === 0x200c ||
    code === 0x200d ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xe0100 && code <= 0xe01ef)
  );
}
/** Qualcosa da leggere: una lettera, una cifra, un simbolo (anche emoji) o un segno di punteggiatura. */
const READABLE = /[\p{L}\p{N}\p{S}\p{P}]/u;

/**
 * La descrizione come la salva il server (e come la ripulisce chi la legge): NFC, a capo
 * uniformati in \n, tabulazioni in spazi, via i caratteri di controllo e quelli invisibili che
 * cambiano la direzione del testo (override e isolamenti bidi, marcatori di direzione, spazi a
 * larghezza zero) o che sembrano vuoti (riempitivi, trattino morbido, caratteri tag), spazi a fine
 * riga tolti, al massimo una riga vuota di seguito, niente spazi o righe vuote all'inizio e alla
 * fine. Restano i joiner U+200C/U+200D (parole persiane, indiane ed emoji composte), i selettori di
 * variante (\u2764\ufe0f) e le bandiere con tag. Un testo senza nulla da leggere (n\u00e9 lettere, n\u00e9 cifre, n\u00e9
 * simboli, n\u00e9 punteggiatura) diventa null (nessuna descrizione).
 */
export function normalizePlaylistDescription(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .normalize('NFC')
    .replace(/\r\n?|[\u0085\u2028\u2029]/g, '\n')
    .replace(/\t/g, ' ')
    .replace(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: strip control characters.
      /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g,
      '',
    )
    .replace(HIDDEN_CHARACTERS, (match, flag?: string) =>
      flag || isKeptIgnorable(match) ? match : '',
    )
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned && READABLE.test(cleaned) ? cleaned : null;
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

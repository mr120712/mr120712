// @polsia:user-owned — quiz musicale condivisibile («Chi interpreta “Titolo”?»): link, lettura dei
// suoi parametri, testi e indirizzo canonico della scheda di anteprima (quiz/anteprima.jpg).
// Modulo puro (client, server e proxy): niente API solo Node, niente import server-only.
//
// La RISPOSTA (l'artista) non deve mai essere leggibile in ciò che chi riceve il link vede prima di
// girare la carta: né nel testo condiviso, né nel link visibile nella chat, né in og:title o
// og:description, né nell'immagine o nel suo indirizzo. Per questo il link porta solo c=<codice>:
// "1." (versione) + base64url senza "=" dei byte UTF-8 di titolo + U+001F + artista. Non è una
// cifratura (chi vuole barare può decodificarlo), è un modo per non mostrare la risposta.
// La lettura del codice è totale: qualsiasi input rovinato dà null, mai un errore.
import {
  audiusTrackIdOrNull,
  publicShareUrl,
  SONG_SHARE_URL_MAX,
  searchParamsRecord,
  shareCardText,
  strictEncode,
} from '@/lib/business/social-share';
import { publicSiteUrl } from '@/lib/public-links';

/** Un quiz letto da un link: testo già pulito; `audiusId` lo verifica il server prima dell'uso. */
export type SongQuiz = { title: string; artist: string; audiusId: string | null };

type ParamRecord = Record<string, string | string[] | undefined>;

/** Pagina pubblica del quiz. */
export const QUIZ_PATH = '/quiz';
/**
 * «Crea la tua sfida»: le flashcard aperte sul mazzo dei tuoi ascolti, l'unico le cui carte hanno
 * «Sfida un amico» (flashcards-view legge ?mazzo=).
 */
export const QUIZ_CREATE_PATH = '/flashcards?mazzo=ascolti';
/** Percorso della scheda generica del quiz (nessun brano): senza query. */
export const QUIZ_PREVIEW_IMAGE_BASE = '/quiz/anteprima.jpg';
/** Versione del codice: un formato diverso in futuro avrà un altro prefisso. */
const CODE_PREFIX = '1.';
/**
 * Lunghezza massima del codice (circa 1 KB): oltre, lo si rifiuta prima di decodificarlo. Chi crea
 * il link accorcia il titolo (mai l'artista) finché il codice ci sta.
 */
export const QUIZ_CODE_MAX = 1024;
/** Separatore tra titolo e artista (U+001F, "unit separator"): non resta mai nel testo pulito. */
const SEPARATOR = '\u001F';
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Titolo del contenuto condiviso (oggetto dell'email, titolo nel menu del telefono). */
export const QUIZ_SHARE_TITLE = 'Quiz musicale su Solco';
/** Titolo e descrizione della pagina (e dell'anteprima) quando il link non descrive un quiz. */
export const QUIZ_GENERIC_TITLE = 'Quiz musicale su Solco';
export const QUIZ_DESCRIPTION =
  'Indovina chi interpreta il brano, gira la carta per scoprirlo e ascoltalo su Solco.';

/**
 * Caratteri di controllo (tra cui il separatore) e controlli bidirezionali (incorporamento,
 * forzatura, isolamento): questi ultimi farebbero apparire il testo che segue al contrario.
 * I caratteri invisibili delle emoji composte (ZWJ) restano.
 */
const CONTROL = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu;

/** Testo del quiz pulito come quello dei link condivisi (shareCardText) e senza controlli. */
function quizText(value: string, kind: 'title' | 'artist'): string {
  return shareCardText(value.replace(CONTROL, ' '), kind);
}

/** Per confrontare titolo e artista: minuscolo, senza accenti, solo parole (lettere e cifre). */
function folded(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('it-IT')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Scritture senza spazi tra le parole: lì l'artista si cerca come sequenza, non come parola. */
const NO_SPACES_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

/** L'artista è leggibile nel titolo (come parola intera; ovunque per cinese, giapponese, thai). */
function titleNamesArtist(title: string, artist: string): boolean {
  const name = folded(artist);
  if (!name) return false;
  const text = folded(title);
  return NO_SPACES_SCRIPT.test(name) ? text.includes(name) : ` ${text} `.includes(` ${name} `);
}

/** Separatore tra artista e titolo nei titoli caricati: «Artista - Titolo», «Artista: Titolo». */
const ARTIST_TITLE_SEPARATOR = /\s[-–—|]\s|:\s/;

/** «Artista - Titolo» → «Titolo» (anche «Titolo - Artista»), solo se quella parte è l'artista. */
function withoutArtistPart(title: string, artist: string): string {
  const match = ARTIST_TITLE_SEPARATOR.exec(title);
  if (!match) return title;
  const before = title.slice(0, match.index);
  const after = title.slice(match.index + match[0].length);
  const name = folded(artist);
  if (folded(before) === name) return after;
  if (folded(after) === name) return before;
  return title;
}

/**
 * Titolo e artista di un quiz, puliti, solo se la domanda non svela la risposta. Molti brani
 * (Audius, Jamendo) hanno titoli come «Artista - Titolo (feat. …)»: quella parte si toglie; se
 * l'artista resta comunque leggibile nel titolo (es. «Killer Queen» dei Queen) il quiz non si fa.
 * null anche senza titolo o senza artista. Idempotente sul proprio risultato.
 */
export function quizSong(song: {
  title: string;
  artist: string | null;
}): { title: string; artist: string } | null {
  const artist = quizText(song.artist ?? '', 'artist');
  const full = quizText(song.title, 'title');
  if (!artist || !full) return null;
  const title = quizText(withoutArtistPart(full, artist), 'title');
  if (!title || titleNamesArtist(title, artist)) return null;
  return { title, artist };
}

function firstParam(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : Array.isArray(value) ? (value[0] ?? '') : '';
}

function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += BASE64URL[(n >> 18) & 63] ?? '';
    out += BASE64URL[(n >> 12) & 63] ?? '';
    if (b !== undefined) out += BASE64URL[(n >> 6) & 63] ?? '';
    if (c !== undefined) out += BASE64URL[n & 63] ?? '';
  }
  return out;
}

/** I byte di un base64url senza "=", o null se non è valido o non è nella forma canonica. */
function fromBase64Url(text: string): Uint8Array | null {
  if (text.length % 4 === 1) return null;
  const bytes = new Uint8Array(Math.floor((text.length * 3) / 4));
  let length = 0;
  let buffer = 0;
  let bits = 0;
  for (const char of text) {
    const value = BASE64URL.indexOf(char);
    if (value < 0) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[length] = (buffer >> bits) & 0xff;
      length += 1;
    }
    buffer &= (1 << bits) - 1;
  }
  // I bit avanzati devono essere zero: un solo codice per lo stesso testo.
  return buffer === 0 ? bytes.subarray(0, length) : null;
}

function encodeCode(title: string, artist: string): string {
  return `${CODE_PREFIX}${toBase64Url(new TextEncoder().encode(`${title}${SEPARATOR}${artist}`))}`;
}

/**
 * Titolo e artista di un codice c=, già puliti. null per qualsiasi input non valido: troppo lungo
 * (rifiutato prima di decodificarlo), versione sconosciuta, base64url o UTF-8 rovinati, separatore
 * assente o ripetuto, titolo o artista vuoti dopo la pulizia, titolo che svela l'artista (le
 * stesse regole di chi crea il link: quizSong).
 */
export function decodeSongQuizCode(code: unknown): { title: string; artist: string } | null {
  try {
    if (typeof code !== 'string' || code.length > QUIZ_CODE_MAX) return null;
    if (!code.startsWith(CODE_PREFIX)) return null;
    const bytes = fromBase64Url(code.slice(CODE_PREFIX.length));
    if (!bytes || bytes.length === 0) return null;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parts = text.split(SEPARATOR);
    if (parts.length !== 2) return null;
    return quizSong({ title: parts[0] ?? '', artist: parts[1] ?? '' });
  } catch {
    return null;
  }
}

/**
 * Link pubblico del quiz di un brano: <base>/quiz?c=<codice>, più &au=<id> per un brano Audius
 * (la scheda di anteprima ne legge titolo e copertina dal server). Resta sotto SONG_SHARE_URL_MAX
 * (chi non ha un account passa dall'accesso e torna qui) e il codice sotto QUIZ_CODE_MAX: se
 * serve si accorcia il titolo, mai l'artista. null senza titolo o senza artista, o se il titolo
 * svela l'artista (quizSong).
 */
export function songQuizUrl(
  song: { title: string; artist: string | null; audiusId?: string | null },
  base = publicSiteUrl(),
): string | null {
  const clean = quizSong(song);
  if (!clean) return null;
  const id = audiusTrackIdOrNull(song.audiusId);
  const idParam = id ? `&au=${id}` : '';
  let chars = Array.from(clean.title);
  while (chars.length > 0) {
    // Anche il titolo accorciato passa dalle stesse regole: il codice si rilegge identico.
    const short = quizSong({ title: chars.join(''), artist: clean.artist });
    if (short) {
      const code = encodeCode(short.title, short.artist);
      const url = publicShareUrl(`${QUIZ_PATH}?c=${code}${idParam}`, base);
      if (code.length <= QUIZ_CODE_MAX && url.length <= SONG_SHARE_URL_MAX) return url;
    }
    chars = chars.slice(0, -1);
  }
  return null;
}

/** Il quiz di un link (c obbligatorio, au facoltativo), o null se c manca o non è valido. */
export function songQuizFromParams(params: ParamRecord): SongQuiz | null {
  const decoded = decodeSongQuizCode(firstParam(params.c));
  if (!decoded) return null;
  return { ...decoded, audiusId: audiusTrackIdOrNull(firstParam(params.au)) };
}

/**
 * Tutto ciò che serve a «Sfida un amico» (player, flashcard, pagina del quiz): link, testo e scheda
 * di anteprima, con il titolo così come lo legge chi riceve il link (pulito, senza la parte con
 * l'artista, eventualmente accorciato). null se il brano non può diventare un quiz.
 */
export function songQuizShare(
  song: { title: string; artist: string | null; audiusId?: string | null },
  base = publicSiteUrl(),
): { title: string; text: string; url: string; imageUrl: string } | null {
  const url = songQuizUrl(song, base);
  if (!url) return null;
  const quiz = songQuizFromParams(searchParamsRecord(new URL(url).searchParams));
  if (!quiz) return null;
  return {
    title: quiz.title,
    text: quizShareText(quiz.title),
    url,
    imageUrl: quizPreviewImagePath(quiz),
  };
}

/**
 * Percorso canonico della pagina di un quiz (og:url della pagina e dell'anteprima in modalità
 * attacco, entrambe sull'origine dell'app): il link ricostruito dal quiz letto, o /quiz se non
 * c'è un quiz.
 */
export function quizPagePath(quiz: SongQuiz | null): string {
  const url = quiz ? songQuizUrl(quiz) : null;
  if (!url) return QUIZ_PATH;
  const { pathname, search } = new URL(url);
  return `${pathname}${search}`;
}

/**
 * Indirizzo canonico della scheda di anteprima (JPEG 1200×630) di un quiz. Mai l'artista: con un
 * id Audius solo ?au=<id> (titolo e copertina sfocata arrivano da Audius), altrimenti ?t=<titolo>,
 * senza brano la scheda generica. Pulisce da sé il titolo, così il menu di condivisione e la pagina
 * ottengono lo stesso identico indirizzo (una sola voce nella CDN).
 */
export function quizPreviewImagePath(
  quiz: { title?: string | null; audiusId?: string | null } | null,
): string {
  const audiusId = audiusTrackIdOrNull(quiz?.audiusId);
  if (audiusId) return `${QUIZ_PREVIEW_IMAGE_BASE}?au=${audiusId}`;
  const title = quizText(quiz?.title ?? '', 'title');
  return title ? `${QUIZ_PREVIEW_IMAGE_BASE}?t=${strictEncode(title)}` : QUIZ_PREVIEW_IMAGE_BASE;
}

/** La scheda chiesta all'immagine (parametri t e au), o null per la scheda generica. */
export function quizImageFromParams(
  params: ParamRecord,
): { title: string; audiusId: string | null } | null {
  const audiusId = audiusTrackIdOrNull(firstParam(params.au));
  const title = quizText(firstParam(params.t), 'title');
  if (!title && !audiusId) return null;
  return { title, audiusId };
}

/**
 * L'immagine di anteprima di un link creato da songQuizUrl: la stessa che la pagina /quiz mette in
 * og:image per quel link (stessa lettura dei parametri, stesso indirizzo canonico).
 */
export function quizShareImagePath(quizUrl: string): string {
  try {
    const params = searchParamsRecord(new URL(quizUrl, 'https://solco.invalid').searchParams);
    return quizPreviewImagePath(songQuizFromParams(params));
  } catch {
    return QUIZ_PREVIEW_IMAGE_BASE;
  }
}

/** La domanda della carta: «Chi interpreta «Titolo»?». */
export function quizQuestion(title: string): string {
  return `Chi interpreta «${quizText(title, 'title')}»?`;
}

/** Titolo della pagina e dell'anteprima social di un quiz (senza l'artista). */
export function quizPageTitle(title: string): string {
  return `Quiz: chi interpreta «${quizText(title, 'title')}»?`;
}

/** Testo che accompagna il link: la domanda, mai la risposta. */
export function quizShareText(title: string): string {
  const name = quizText(title, 'title');
  return name
    ? `Sai chi interpreta «${name}»? Gira la carta su Solco.`
    : 'Sai chi interpreta questo brano? Gira la carta su Solco.';
}

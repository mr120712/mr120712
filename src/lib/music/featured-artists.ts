// @polsia:user-owned — artisti dei "brani in evidenza" (logica pura, client e server): dal nome
// "Artista - Titolo" del file (trackNameFromPathname) all'artista principale e agli ospiti
// ("feat."), lo slug della pagina /artista/<slug> e il raggruppamento dei brani per artista.
// Nessun accesso allo store qui: chi raggruppa passa SOLO i brani con i diritti dichiarati
// (indice di featured-search.server), mai l'elenco grezzo della Home.
//
// Regole:
// - artista principale = il testo prima di " feat.", " feat ", " ft.", " ft ", " featuring "
//   (maiuscole indifferenti, ":" facoltativo dopo, anche fra parentesi: "Artista (feat. Ospite)");
// - gli ospiti dopo il "feat." possono essere più d'uno, separati da ",", " & " o " e "; anche un
//   "feat." nel TITOLO conta, solo se c'è un artista: fra parentesi ("Titolo (feat. Ospite)") o in
//   coda ("Titolo ft. Ospite": qui solo "feat.", "ft." o "featuring", perché "feat" da solo è
//   anche una parola inglese, "A Great Feat");
// - un brano appartiene al suo artista principale E a ogni ospite (una volta sola per artista);
// - slug: NFKD, senza accenti, minuscolo, ogni sequenza non alfanumerica → "-", niente trattini
//   ai bordi, al massimo 80 caratteri; slug vuoto = nessuna pagina. Un nome con lettere o cifre
//   NON latine (CJK, cirillico, greco…) ha slug vuoto anche se contiene lettere latine o cifre:
//   altrimenti "乃木坂46" e "日向坂46" finirebbero entrambi su "46" (artisti diversi, una pagina);
//   due grafie con lo stesso slug ("Lucio Dalla", "LUCIO DALLA") sono lo stesso artista,
//   mostrato con la grafia più frequente (a parità, quella del brano più recente);
// - un brano senza artista non crea nessuna pagina.

/** Lunghezza massima di uno slug d'artista. */
export const ARTIST_SLUG_MAX_LENGTH = 80;
/** Forma di uno slug valido: minuscole e cifre separate da un solo trattino. */
export const ARTIST_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Prefisso della pagina d'artista. */
export const FEATURED_ARTIST_PAGE_PREFIX = '/artista/';

/** Lettere latine che NFKD non scompone (ß, æ, ø…): la loro forma senza segni. */
const LATIN_LETTERS: Readonly<Record<string, string>> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ł: 'l',
  ı: 'i',
  ħ: 'h',
};
const LATIN_LETTERS_RE = /[ßæœøđðþłıħ]/g;

/**
 * Marcatore degli ospiti: " feat.", " feat ", " ft.", " ft ", " featuring " (maiuscole
 * indifferenti, ":" facoltativo dopo: "featuring: X"), anche subito dopo una parentesi aperta.
 * Senza spazio prima non vale: "Daft Punk" resta un artista solo.
 */
const FEAT_MARKER = /(?:\s+[([]?|\s*[([])(?:(?:feat|ft)\.|(?:feat|ft|featuring)(?=[\s:]))\s*:?\s*/i;
/** Separatori fra più ospiti: ",", " & ", " e " (e un altro "feat." ripetuto). */
const GUEST_SEPARATOR =
  /\s*,\s*|\s+&\s+|\s+e\s+|\s+(?:(?:feat|ft)\.|(?:feat|ft|featuring)(?=[\s:]))\s*:?\s*/i;
/** "(feat. Ospite)" / "[ft. Ospite]" dentro il titolo. */
const TITLE_FEAT = /[([]\s*(?:(?:feat|ft)\.|(?:feat|ft|featuring)(?=[\s:]))\s*:?\s*([^)\]]+)[)\]]/i;
/**
 * "Titolo ft. Ospite" senza parentesi, fino a un'eventuale parentesi ("… ft. Ospite (Remix)").
 * Solo "feat.", "ft." e "featuring": "feat"/"ft" senza punto qui sarebbero troppo ambigui.
 */
const TITLE_FEAT_BARE = /\s(?:(?:feat|ft)\.|featuring(?=[\s:]))\s*:?\s*([^()[\]]+)/i;
/** Separatori rimasti ai bordi di un nome: "Artista &" (da "Artista & Feat X"), "Artista e". */
const EDGE_SEPARATORS = /^\s*(?:[,&]\s*)+|(?:\s*[,&]|\s+e)+\s*$/g;
/** Un nome tutto fra una coppia di parentesi: "(X)" (da "Artista feat. (X)"). */
const ENCLOSED_NAME = /^[([]([^()[\]]*)[)\]]$/;
/**
 * Lettere o cifre rimaste fuori da [a-z0-9] dopo la normalizzazione (CJK, cirillico, greco…).
 * Le lettere modificatrici (\p{Lm}: l'apostrofo "ʼ" di "Guns Nʼ Roses") contano come punteggiatura.
 */
const NON_LATIN_ALNUM = /(?!\p{Lm})[\p{L}\p{N}]/u;

/**
 * Lo slug di un nome d'artista; '' (= nessuna pagina) se non resta nessuna lettera o cifra, o se
 * il nome ha lettere o cifre non latine: niente residui parziali ("乃木坂46" → '', non "46") che
 * unirebbero artisti diversi.
 */
export function artistSlug(name: string): string {
  const plain = name
    .normalize('NFKD')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(LATIN_LETTERS_RE, (letter) => LATIN_LETTERS[letter] ?? letter);
  if (NON_LATIN_ALNUM.test(plain.replace(/[a-z0-9]+/g, ''))) return '';
  const slug = plain.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.slice(0, ARTIST_SLUG_MAX_LENGTH).replace(/-+$/, '');
}

/** True per uno slug ben formato (forma e lunghezza), prima di cercarlo. */
export function isArtistSlug(value: string): boolean {
  return value.length <= ARTIST_SLUG_MAX_LENGTH && ARTIST_SLUG_PATTERN.test(value);
}

/** Percorso della pagina d'artista. */
export function featuredArtistPath(slug: string): string {
  return `${FEATURED_ARTIST_PAGE_PREFIX}${encodeURIComponent(slug)}`;
}

/**
 * Un nome ripulito: spazi compattati, senza separatori ai bordi ("Artista &" → "Artista"), senza
 * la parentesi rimasta SPAIATA ai bordi (da "Artista (feat. Ospite)" resta "Ospite)") e senza la
 * coppia che racchiude tutto il nome ("(X)" → "X"); "Nirvana (UK)" resta intero.
 */
function cleanName(value: string): string {
  let name = value.replace(/\s+/g, ' ').replace(EDGE_SEPARATORS, '').trim();
  if (/^[([]/.test(name) && !/[)\]]/.test(name)) name = name.slice(1).trim();
  if (/[)\]]$/.test(name) && !/[([]/.test(name)) name = name.slice(0, -1).trim();
  const enclosed = ENCLOSED_NAME.exec(name);
  if (enclosed) name = (enclosed[1] ?? '').trim();
  return name;
}

function guestNames(list: string): string[] {
  return list.split(GUEST_SEPARATOR).map(cleanName).filter(Boolean);
}

export type TrackArtists = {
  /** L'artista principale (null se il brano non ha artista). */
  primary: string | null;
  /** Gli ospiti ("feat."), senza ripetizioni né l'artista principale. */
  guests: string[];
};

/**
 * Artista principale e ospiti di un brano, da `artist` (la parte prima di " - " nel nome del
 * file) e dal titolo ("(feat. …)" fra parentesi o "ft. …" in coda). Senza artista: nessuno.
 */
export function parseTrackArtists(artist: string | null, title = ''): TrackArtists {
  const credited = cleanName(artist ?? '');
  if (!credited) return { primary: null, guests: [] };

  let primary = credited;
  const names: string[] = [];
  const marker = FEAT_MARKER.exec(credited);
  if (marker && marker.index > 0) {
    const before = cleanName(credited.slice(0, marker.index));
    // "(feat. X)" senza nulla prima: il nome resta intero, non si inventa un artista vuoto.
    if (before) {
      primary = before;
      names.push(...guestNames(credited.slice(marker.index + marker[0].length)));
    }
  }
  for (const pattern of [TITLE_FEAT, TITLE_FEAT_BARE]) {
    const inTitle = pattern.exec(title);
    if (inTitle?.[1]) names.push(...guestNames(inTitle[1]));
  }

  const seen = new Set([artistSlug(primary)]);
  const guests: string[] = [];
  for (const name of names) {
    const slug = artistSlug(name);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    guests.push(name);
  }
  return { primary, guests };
}

/** Slug dell'artista principale di un brano; null se non c'è artista o lo slug è vuoto. */
export function primaryArtistSlug(artist: string | null): string | null {
  const { primary } = parseTrackArtists(artist);
  if (!primary) return null;
  return artistSlug(primary) || null;
}

/**
 * Il link all'artista sui brani della Home (che elenca anche brani NON dichiarati): `artistSlug`
 * dell'artista principale solo se è fra gli artisti con almeno un brano dichiarato (`declared`),
 * altrimenti null. `declared` null (indice non disponibile) = nessun link. Così nessun link porta a
 * una pagina vuota; la pagina, da parte sua, elenca solo i brani dichiarati.
 */
export function linkDeclaredArtists<T extends { artist: string | null }>(
  tracks: readonly T[],
  declared: ReadonlySet<string> | null,
): Array<T & { artistSlug: string | null }> {
  return tracks.map((track) => {
    const slug = declared ? primaryArtistSlug(track.artist) : null;
    return { ...track, artistSlug: slug && declared?.has(slug) ? slug : null };
  });
}

/** Tutti gli slug (principale e ospiti, senza ripetizioni) a cui appartiene un brano. */
export function trackArtistCredits(track: {
  artist: string | null;
  title: string;
}): Array<{ slug: string; name: string }> {
  const { primary, guests } = parseTrackArtists(track.artist, track.title);
  if (!primary) return [];
  const credits: Array<{ slug: string; name: string }> = [];
  const seen = new Set<string>();
  for (const name of [primary, ...guests]) {
    const slug = artistSlug(name);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    credits.push({ slug, name });
  }
  return credits;
}

export type FeaturedArtistGroup<T> = {
  slug: string;
  /** La grafia più frequente fra i brani (a parità, quella del brano che viene prima). */
  name: string;
  /** I brani dell'artista, nell'ordine ricevuto (dal più recente). */
  tracks: T[];
};

/**
 * Raggruppa per artista (principale e ospiti) i brani ricevuti, che DEVONO essere solo quelli con
 * i diritti dichiarati. Ogni gruppo ha almeno un brano: uno slug assente = nessuna pagina.
 */
export function groupFeaturedArtists<T extends { artist: string | null; title: string }>(
  tracks: readonly T[],
): Map<string, FeaturedArtistGroup<T>> {
  const building = new Map<
    string,
    { tracks: T[]; spellings: Map<string, { count: number; first: number }> }
  >();
  let order = 0;
  for (const track of tracks) {
    for (const { slug, name } of trackArtistCredits(track)) {
      let group = building.get(slug);
      if (!group) {
        group = { tracks: [], spellings: new Map() };
        building.set(slug, group);
      }
      group.tracks.push(track);
      const spelling = group.spellings.get(name);
      if (spelling) spelling.count += 1;
      else group.spellings.set(name, { count: 1, first: order });
      order += 1;
    }
  }

  const groups = new Map<string, FeaturedArtistGroup<T>>();
  for (const [slug, group] of building) {
    let best: { name: string; count: number; first: number } | null = null;
    for (const [name, spelling] of group.spellings) {
      if (
        !best ||
        spelling.count > best.count ||
        (spelling.count === best.count && spelling.first < best.first)
      ) {
        best = { name, ...spelling };
      }
    }
    if (best) groups.set(slug, { slug, name: best.name, tracks: group.tracks });
  }
  return groups;
}

/** Una copia mescolata (Fisher–Yates): l'originale non cambia, gli elementi restano tutti. */
export function shuffledCopy<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.min(index, Math.floor(random() * (index + 1)));
    [copy[index], copy[other]] = [copy[other] as T, copy[index] as T];
  }
  return copy;
}

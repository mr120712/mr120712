// @polsia:user-owned — «Potrebbe piacerti»: funzioni pure (profilo di gusto, motivi, esclusioni,
// punteggio, varietà per artista, ordine fisso per giorno e pagine di «Altri consigli»). Nessuna
// rete e nessun database: il motore server (recommendations.server.ts) le usa con i dati già letti
// e i test le provano da sole.
import { z } from 'zod';
import {
  RECOMMENDATION_MAX_PAGE,
  type RecommendationItem,
  RecommendationItemSchema,
  type RecommendationReason,
  type RecommendationReasonKind,
} from '@/lib/contracts/recommendations';
import { AUDIUS_GENRES, AUDIUS_MOODS, type AudiusGenre } from '@/lib/music/moods';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Ascolti considerati (e brani esclusi perché già ascoltati): gli ultimi 60 giorni. */
export const RECOMMENDATION_WINDOW_DAYS = 60;
/** Metà peso ogni 3 settimane: gli ascolti recenti contano di più. */
const RECENCY_HALF_LIFE_DAYS = 21;
/** Un brano riascoltato all'infinito non deve decidere da solo il profilo. */
const MAX_PLAYS_PER_TRACK = 10;
/** Artisti tenuti nel profilo. */
const MAX_PROFILE_ARTISTS = 8;
/** Varietà: al massimo 2 brani dello stesso artista per pagina. */
export const MAX_PER_ARTIST = 2;
/** Un'ultima pagina più corta di così non vale un «Altri consigli»: si ricomincia da capo. */
const MIN_TRAILING_PAGE = 6;

/** Fonti dei candidati: decidono il motivo mostrato e il peso di partenza. */
export type PoolSource = RecommendationReasonKind;

const BASE_SCORE: Record<PoolSource, number> = {
  artist: 5,
  similar: 3.5,
  // Nessun genere o mood su cui guadagnare affinità: parte più in alto per competere in prima pagina.
  ai: 4.5,
  community: 3,
  genre: 2.5,
  trending: 1.5,
};

/** Quando più fonti propongono lo stesso brano, il motivo mostrato è quello della più forte. */
const SOURCE_PRIORITY: Record<PoolSource, number> = {
  artist: 6,
  similar: 5,
  ai: 4,
  community: 3,
  genre: 2,
  trending: 1,
};

/** Prefissi che non diventano mai consigli (né semi): brani caricati, file locali, video, radio. */
const NEVER_RECOMMENDED = /^(upload|local|youtube|radio|podcast):/;

/**
 * Normalizzazione dei nomi d'artista (maiuscole, accenti, punteggiatura), la stessa di
 * songIdentity: "Beyoncé", "beyonce" e "BEYONCÉ!" sono lo stesso artista.
 */
export function normalizeArtistKey(name: string) {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Prefisso ammesso per un consiglio: Audius o "song"; mai caricati, locali, YouTube o radio. */
export function isRecommendableKey(qualifiedId: string) {
  return /^(audius:[A-Za-z0-9_-]{1,128}|song:[a-f0-9]{32})$/.test(qualifiedId);
}

const GENRE_BY_LOWER = new Map<string, AudiusGenre>(
  AUDIUS_GENRES.map((genre) => [genre.toLowerCase(), genre]),
);

/** Parole (dopo normalizeArtistKey) → genere Audius. L'ordine conta: "deep house" prima di "house". */
const GENRE_RULES: readonly [RegExp, AudiusGenre][] = [
  [/\bdeep house\b/, 'Deep House'],
  [/\b(hip hop|hiphop|rap)\b/, 'Hip-Hop/Rap'],
  [/\b(r b|rnb|soul)\b/, 'R&B/Soul'],
  [/\blo ?fi\b/, 'Lo-Fi'],
  [/\b(drum (and|n) bass|dnb|drum bass)\b/, 'Drum & Bass'],
  [/\bdubstep\b/, 'Dubstep'],
  [/\btrap\b/, 'Trap'],
  [/\btechno\b/, 'Techno'],
  [/\bhouse\b/, 'House'],
  [/\b(downtempo|chill ?out|chill)\b/, 'Downtempo'],
  [/\bambient\b/, 'Ambient'],
  [/\b(electronic|electronica|elettronica|edm|dance|elettronic)\b/, 'Electronic'],
  [/\b(classical|classica|orchestral|opera)\b/, 'Classical'],
  [/\bjazz\b/, 'Jazz'],
  [/\b(latin|latina|latino|reggaeton|salsa)\b/, 'Latin'],
  [/\b(acoustic|acustica|acustico|folk|cantautor\w*|singer songwriter)\b/, 'Acoustic'],
  [/\bfunk\b/, 'Funk'],
  [/\bdisco\b/, 'Disco'],
  [/\b(alternative|alternativ\w*|indie|rock|punk|grunge)\b/, 'Alternative'],
  [/\bpop\b/, 'Pop'],
];

/** Il genere Audius più vicino a un genere libero (catalogo Audius o diario), oppure null. */
export function toAudiusGenre(raw: string | null | undefined): AudiusGenre | null {
  if (!raw) return null;
  const exact = GENRE_BY_LOWER.get(raw.trim().toLowerCase());
  if (exact) return exact;
  const words = normalizeArtistKey(raw);
  if (!words) return null;
  for (const [pattern, genre] of GENRE_RULES) {
    if (pattern.test(words)) return genre;
  }
  return null;
}

const MOOD_BY_LOWER = new Map<string, string>(
  AUDIUS_MOODS.map((mood) => [mood.toLowerCase(), mood]),
);

/** Il mood Audius (valori accettati dall'API) di un brano, oppure null. */
export function toAudiusMood(raw: string | null | undefined) {
  return raw ? (MOOD_BY_LOWER.get(raw.trim().toLowerCase()) ?? null) : null;
}

// ---------- Profilo di gusto ----------

export type HistorySeed = {
  qualifiedId: string;
  artistName: string;
  playCount: number;
  lastPlayedAt: Date;
  /** Handle Audius ricavato dal link ufficiale audius.co/<handle>/<brano>, se c'è. */
  handle: string | null;
};

export type LibrarySeed = {
  qualifiedId: string;
  artistName: string | null;
  /** Peso nel gusto: Preferiti più delle playlist; 0 = conta solo per non riproporlo. */
  weight: number;
};

export type DiarySeed = { artistName: string; genre: string | null; rating: number };

export type TasteArtist = { key: string; name: string; handle: string | null; weight: number };

export type TasteProfile = {
  /** Artisti in ordine di peso (al massimo 8). */
  artists: TasteArtist[];
  /** Generi del diario (album votati 4 o 5), già portati ai generi Audius. */
  diaryGenres: { genre: AudiusGenre; weight: number }[];
  /** Brani da non riproporre: ascoltati negli ultimi 60 giorni o già nella Libreria. */
  excluded: Set<string>;
};

function recencyWeight(lastPlayedAt: Date, now: Date) {
  const ageDays = Math.max(0, (now.getTime() - lastPlayedAt.getTime()) / DAY_MS);
  return 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS);
}

/**
 * Profilo dai SOLI dati dell'utente: ascolti Audius/Jamendo degli ultimi 60 giorni (conteggio e
 * recenza), Preferiti e playlist, diario. Le voci YouTube, i brani caricati e i file locali non
 * arrivano qui (il server non li legge) e vengono comunque scartati.
 */
export function buildTasteProfile(input: {
  history: readonly HistorySeed[];
  library: readonly LibrarySeed[];
  diary: readonly DiarySeed[];
  now: Date;
  /** Altre chiavi da escludere (es. i "song" degli stessi brani già ascoltati). */
  extraExcluded?: Iterable<string>;
}): TasteProfile {
  const cutoff = input.now.getTime() - RECOMMENDATION_WINDOW_DAYS * DAY_MS;
  const artists = new Map<string, TasteArtist>();
  const excluded = new Set<string>(input.extraExcluded ?? []);

  const addArtist = (name: string | null, weight: number, handle: string | null = null) => {
    const trimmed = name?.trim() ?? '';
    const key = normalizeArtistKey(trimmed);
    if (!key || weight <= 0) return;
    const current = artists.get(key);
    if (current) {
      current.weight += weight;
      current.handle ??= handle;
    } else {
      artists.set(key, { key, name: trimmed.slice(0, 120), handle, weight });
    }
  };

  for (const row of input.history) {
    if (NEVER_RECOMMENDED.test(row.qualifiedId)) continue;
    if (!/^(audius|jamendo):/.test(row.qualifiedId)) continue;
    if (row.lastPlayedAt.getTime() < cutoff) continue;
    excluded.add(row.qualifiedId);
    const plays = Math.min(MAX_PLAYS_PER_TRACK, Math.max(1, row.playCount));
    addArtist(row.artistName, plays * recencyWeight(row.lastPlayedAt, input.now), row.handle);
  }
  for (const item of input.library) {
    if (!isRecommendableKey(item.qualifiedId)) continue;
    excluded.add(item.qualifiedId);
    addArtist(item.artistName, item.weight);
  }
  const diaryGenres = new Map<AudiusGenre, number>();
  for (const entry of input.diary) {
    if (entry.rating < 4) continue;
    const weight = entry.rating >= 5 ? 3 : 2;
    addArtist(entry.artistName, weight);
    const genre = toAudiusGenre(entry.genre);
    if (genre) diaryGenres.set(genre, (diaryGenres.get(genre) ?? 0) + weight);
  }

  return {
    artists: [...artists.values()]
      .sort((left, right) => right.weight - left.weight || left.key.localeCompare(right.key))
      .slice(0, MAX_PROFILE_ARTISTS),
    diaryGenres: [...diaryGenres.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([genre, weight]) => ({ genre, weight })),
    excluded,
  };
}

/** Niente da cui partire: né artisti né generi del diario. */
export function isColdStart(profile: TasteProfile) {
  return profile.artists.length === 0 && profile.diaryGenres.length === 0;
}

// ---------- Motivi ----------

function shortName(name: string) {
  const trimmed = name.trim();
  return trimmed.length > 60 ? `${trimmed.slice(0, 59)}…` : trimmed;
}

/** Il motivo, breve e in italiano, mostrato sotto ogni brano. */
export function reasonFor(
  kind: PoolSource,
  detail: { artist?: string; genre?: string } = {},
): RecommendationReason {
  const artist = detail.artist ? shortName(detail.artist) : '';
  const genre = detail.genre ? shortName(detail.genre) : '';
  switch (kind) {
    case 'artist':
      return { kind, text: artist ? `Perché hai ascoltato ${artist}` : 'Dai tuoi ascolti' };
    // Brani popolari nel genere di un artista che ascolti: nessun confronto diretto con l'artista,
    // quindi il motivo non promette una somiglianza («Simile a …») che nessuno ha verificato.
    case 'similar':
      return {
        kind,
        text: artist ? `Popolare nel genere di ${artist}` : 'Popolare nei generi che ascolti',
      };
    case 'genre':
      return { kind, text: genre ? `Popolare nel genere ${genre}` : 'Popolare nei tuoi generi' };
    case 'community':
      return { kind, text: 'Piace alla community' };
    case 'trending':
      return { kind, text: 'Di tendenza su Audius' };
    case 'ai':
      return {
        kind,
        text: artist ? `Suggerito dall’AI, simile a ${artist}` : 'Suggerito dall’AI per te',
      };
  }
}

// ---------- Candidati ----------

/** Un candidato pronto (contratto della riga) con le informazioni per ordinarlo. */
export const PoolEntrySchema = z.object({
  item: RecommendationItemSchema,
  source: z.enum(['artist', 'similar', 'genre', 'community', 'trending', 'ai']),
  /** Posizione nella lista della sua fonte (0 = il più popolare o pertinente). */
  rank: z.number().int().min(0),
  genre: z.enum(AUDIUS_GENRES).nullable(),
  mood: z.string().max(40).nullable(),
  /** Altre fonti che hanno proposto lo stesso brano. */
  alsoIn: z.array(z.enum(['artist', 'similar', 'genre', 'community', 'trending', 'ai'])),
});
export type PoolEntry = z.infer<typeof PoolEntrySchema>;

/**
 * Unisce le liste delle fonti senza doppioni (stesso qualifiedId): resta la voce della fonte più
 * forte, le altre fonti contano come conferma (alsoIn). L'ordine delle liste non cambia l'esito.
 */
export function mergeCandidates(lists: readonly (readonly PoolEntry[])[]): PoolEntry[] {
  const byKey = new Map<string, PoolEntry>();
  for (const list of lists) {
    for (const entry of list) {
      const key = entry.item.qualifiedId;
      const current = byKey.get(key);
      if (!current) {
        byKey.set(key, { ...entry, alsoIn: [...entry.alsoIn] });
        continue;
      }
      const stronger = SOURCE_PRIORITY[entry.source] > SOURCE_PRIORITY[current.source];
      const winner = stronger ? entry : current;
      const loser = stronger ? current : entry;
      const alsoIn = new Set([...current.alsoIn, ...entry.alsoIn, loser.source]);
      alsoIn.delete(winner.source);
      byKey.set(key, { ...winner, alsoIn: [...alsoIn].sort() });
    }
  }
  return [...byKey.values()];
}

/** Posti tenuti per community e tendenze: i brani degli artisti e dei generi non li occupano tutti. */
export const GENERAL_POOL_SLOTS = 20;

const isGeneralSource = (entry: PoolEntry) =>
  entry.source === 'community' || entry.source === 'trending';

/**
 * Taglia i candidati (già filtrati) a `limit` senza perdere le fonti uguali per tutti: fino a
 * `generalSlots` posti restano a community e tendenze, il resto va ai brani personali (artisti,
 * generi) nell'ordine delle loro fonti; i posti personali non usati tornano a community e tendenze.
 * L'ordine relativo dei candidati non cambia.
 */
export function capCandidates(
  entries: readonly PoolEntry[],
  limit: number,
  generalSlots = GENERAL_POOL_SLOTS,
): PoolEntry[] {
  const general = entries.filter(isGeneralSource);
  const personal = entries
    .filter((entry) => !isGeneralSource(entry))
    .slice(0, Math.max(0, limit - Math.min(general.length, generalSlots)));
  const kept = new Set([...personal, ...general.slice(0, Math.max(0, limit - personal.length))]);
  return entries.filter((entry) => kept.has(entry));
}

/**
 * Solo ciò che si può davvero consigliare ora: Audius riproducibile (licenza OML verificata) o
 * "song"; mai caricati/locali/YouTube; mai già ascoltati di recente, già nella Libreria o segnati
 * «Non mi interessa».
 */
export function eligibleEntries(
  pool: readonly PoolEntry[],
  filters: { excluded: ReadonlySet<string>; hidden: ReadonlySet<string> },
): PoolEntry[] {
  const seen = new Set<string>();
  return pool.filter((entry) => {
    const key = entry.item.qualifiedId;
    if (!isRecommendableKey(key) || NEVER_RECOMMENDED.test(key)) return false;
    if (entry.item.kind === 'audius' && entry.item.playbackEligible !== true) return false;
    if (filters.excluded.has(key) || filters.hidden.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------- Ordine fisso per giorno ----------

/** FNV-1a a 32 bit: stesso testo, stesso numero, su ogni server. */
export function hashSeed(text: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Variazione deterministica in [0, 1) per brano e giorno. */
function jitter(seed: number, key: string) {
  return hashSeed(`${seed}|${key}`) / 0x1_0000_0000;
}

/** Il giorno di calendario in Italia (YYYY-MM-DD): l'ordine cambia a mezzanotte, ora italiana. */
export function romeDay(now: Date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function dailySeed(userId: string, day: string) {
  return hashSeed(`${userId}|${day}`);
}

export type RankingContext = {
  /** Peso degli artisti del profilo (chiave normalizzata). */
  artistWeights: ReadonlyMap<string, number>;
  /** Peso dei generi del profilo. */
  genreWeights: ReadonlyMap<AudiusGenre, number>;
  /** Mood ricorrenti negli artisti del profilo. */
  moods: ReadonlySet<string>;
  seed: number;
};

function normalized<K>(weights: ReadonlyMap<K, number>) {
  const max = Math.max(0, ...weights.values());
  return (key: K) => (max > 0 ? (weights.get(key) ?? 0) / max : 0);
}

/** Punteggio di un candidato: fonte, posizione, affinità con artisti/generi/mood, piccola variazione. */
export function scoreEntry(entry: PoolEntry, context: RankingContext) {
  const artistAffinity = normalized(context.artistWeights);
  const genreAffinity = normalized(context.genreWeights);
  let score = BASE_SCORE[entry.source];
  score += Math.max(0, 1 - entry.rank / 50);
  score += 1.5 * artistAffinity(normalizeArtistKey(entry.item.artistName));
  if (entry.genre) score += 1.2 * genreAffinity(entry.genre);
  if (entry.mood && context.moods.has(entry.mood)) score += 0.4;
  score += 0.6 * entry.alsoIn.length;
  score += 1.5 * jitter(context.seed, entry.item.qualifiedId);
  return score;
}

export function rankEntries(entries: readonly PoolEntry[], context: RankingContext) {
  return entries
    .map((entry) => ({ entry, score: scoreEntry(entry, context) }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.entry.item.qualifiedId.localeCompare(right.entry.item.qualifiedId),
    )
    .map(({ entry }) => entry);
}

/**
 * Pagine con al massimo 2 brani per artista: chi supera il tetto passa alle pagine seguenti, nello
 * stesso ordine. Un'ultima pagina troppo corta (meno di 6) viene lasciata: «Altri consigli»
 * ricomincia da capo invece di mostrare due brani soli.
 */
export function paginate(
  entries: readonly PoolEntry[],
  pageSize: number,
  maxPerArtist = MAX_PER_ARTIST,
): PoolEntry[][] {
  const pages: PoolEntry[][] = [];
  let pending = [...entries];
  while (pending.length > 0) {
    const page: PoolEntry[] = [];
    const deferred: PoolEntry[] = [];
    const perArtist = new Map<string, number>();
    for (const entry of pending) {
      const artist = normalizeArtistKey(entry.item.artistName) || entry.item.qualifiedId;
      const count = perArtist.get(artist) ?? 0;
      if (page.length >= pageSize || count >= maxPerArtist) {
        deferred.push(entry);
        continue;
      }
      perArtist.set(artist, count + 1);
      page.push(entry);
    }
    pages.push(page);
    pending = deferred;
  }
  while (pages.length > 1 && (pages.at(-1)?.length ?? 0) < MIN_TRAILING_PAGE) pages.pop();
  return pages;
}

/**
 * La pagina chiesta: stesso giorno e stessa pagina → stessi brani. Finite le pagine, «Altri
 * consigli» ricomincia con un altro ordine (seme del giro) che parte da un altro punto della
 * lista, così i primi brani cambiano davvero; nessuna nuova richiesta esterna.
 */
export function selectPage(
  entries: readonly PoolEntry[],
  context: RankingContext,
  page: number,
  pageSize: number,
): { items: RecommendationItem[]; page: number; nextPage: number | null } {
  const firstRound = paginate(rankEntries(entries, context), pageSize);
  const total = firstRound.length;
  if (total === 0) return { items: [], page, nextPage: null };
  const round = Math.floor(page / total);
  let pages = firstRound;
  if (round > 0) {
    const ranked = rankEntries(entries, { ...context, seed: hashSeed(`${context.seed}:${round}`) });
    const offset = (round * pageSize) % ranked.length;
    pages = paginate([...ranked.slice(offset), ...ranked.slice(0, offset)], pageSize);
  }
  const chosen = pages[page % total] ?? pages[0] ?? [];
  // Altro da mostrare solo se la lista è più lunga della pagina (altrimenti sarebbero gli stessi).
  const nextPage =
    entries.length > chosen.length ? (page >= RECOMMENDATION_MAX_PAGE ? 0 : page + 1) : null;
  return { items: chosen.map((entry) => entry.item), page, nextPage };
}

/** Contesto di ordinamento dal profilo e dai generi/mood scoperti dai brani degli artisti. */
export function rankingContext(
  profile: TasteProfile | null,
  genres: readonly { genre: AudiusGenre; weight: number }[],
  moods: readonly string[],
  seed: number,
): RankingContext {
  const artistWeights = new Map<string, number>();
  for (const artist of profile?.artists ?? []) artistWeights.set(artist.key, artist.weight);
  const genreWeights = new Map<AudiusGenre, number>();
  for (const { genre, weight } of [...genres, ...(profile?.diaryGenres ?? [])]) {
    genreWeights.set(genre, (genreWeights.get(genre) ?? 0) + weight);
  }
  return { artistWeights, genreWeights, moods: new Set(moods), seed };
}

/** Il valore più frequente (a parità, il primo in ordine alfabetico), oppure null. */
export function mostCommon<T extends string>(values: readonly (T | null)[]): T | null {
  const counts = new Map<T, number>();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: T | null = null;
  let bestCount = 0;
  for (const [value, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

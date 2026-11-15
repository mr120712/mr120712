// @polsia:user-owned — «In evidenza da audio.com» lato server: le collection (album, playlist…)
// dell'account audio.com collegato in /admin/audiocom diventano sezioni della Home.
//
// - L'amministratore sceglie le collection (al massimo 6, nell'ordine) dall'elenco del suo account
//   (GET /v1/collection/list); la scelta si salva in AudioComFeaturedCollection (solo gli id).
// - La Home riceve le sezioni già pronte: titolo e copertina (GET /v1/collection/view) e i primi 50
//   brani di ogni collection nel loro ordine (GET /v1/collection/items), con le STESSE regole della
//   ricerca (toAudioComTrack): solo brani musicali pubblici, lo stream SOLO con licenza CC0, CC BY,
//   CC BY-SA o CC BY-ND e mai per le cover; gli altri si ascoltano nel player ufficiale di audio.com.
//   Una collection senza brani musicali validi non diventa una sezione.
// - Le sezioni sono uguali per tutti: si costruiscono sul server con l'account collegato, una
//   richiesta alla volta, e restano in cache 10 minuti (richieste uguali contemporanee ne condividono
//   una sola). Se audio.com non risponde si tengono le ultime sezioni buone fino a un'ora, poi niente:
//   la Home non si rompe mai. Ogni richiesta ad audio.com consuma il limite globale condiviso con la
//   ricerca ('audiocom.search.global', 40 al minuto: audio.com ne ammette 60 per account).
// - Nessun token in un log o in una risposta (solo nomi d'errore).
import 'server-only';
import { z } from 'zod';
import { consumeRateLimit } from '@/lib/business/rate-limit.server';
import type { AudioComTrack } from '@/lib/contracts/audiocom';
import {
  AUDIOCOM_COLLECTION_TRACKS_MAX,
  AUDIOCOM_COLLECTIONS_LIST_MAX,
  AUDIOCOM_FEATURED_COLLECTIONS_MAX,
  type AudioComCollectionSummary,
  type AudioComCollectionsAdminResponse,
  type AudioComHomeSection,
  AudioComHomeSectionSchema,
} from '@/lib/contracts/audiocom-collections';
import { prisma } from '@/lib/db';
import { AUDIOCOM_RATE_LIMIT_IDENTITY, toAudioComTrack } from '@/lib/music/audiocom.server';
import {
  AUDIOCOM_API_ORIGIN,
  audioComRequest,
  getAudioComAccessToken,
  markAudioComAccessRejected,
  recordAudioComError,
} from '@/lib/music/audiocom-connection.server';
import { AUDIOCOM_ID_PATTERN, audioComImageUrl } from '@/lib/music/audiocom-license';

export const AUDIOCOM_COLLECTION_LIST_URL = `${AUDIOCOM_API_ORIGIN}/v1/collection/list`;
export const AUDIOCOM_COLLECTION_VIEW_URL = `${AUDIOCOM_API_ORIGIN}/v1/collection/view`;
export const AUDIOCOM_COLLECTION_ITEMS_URL = `${AUDIOCOM_API_ORIGIN}/v1/collection/items`;
/** Sezioni in cache dopo una costruzione riuscita. */
export const AUDIOCOM_SECTIONS_TTL_MS = 10 * 60_000;
/** Dopo un problema si riprova al più presto fra un minuto (intanto le ultime sezioni buone). */
export const AUDIOCOM_SECTIONS_RETRY_MS = 60_000;
/** Le ultime sezioni buone si servono al più per un'ora mentre audio.com non risponde. */
export const AUDIOCOM_SECTIONS_STALE_MAX_MS = 60 * 60_000;
const REQUEST_TIMEOUT_MS = 6_000;
const MAX_BODY_BYTES = 1024 * 1024;

const optionalText = z.string().max(2_000).nullish();

/** Il modello Collection dell'API: si leggono solo i campi usati, gli altri sono ammessi. */
const RawCollectionSchema = z
  .object({
    id: z.union([z.string(), z.number().int().nonnegative()]).transform(String),
    title: optionalText,
    type: optionalText,
    items_count: z.number().int().nonnegative().nullish(),
    is_listed: z.boolean().nullish(),
    image: optionalText,
  })
  .passthrough();

// biome-ignore lint/suspicious/noControlCharactersInRegex: toglie i caratteri di controllo dai testi.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function cleanText(value: string | null | undefined, max: number): string {
  return (value ?? '').replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Una collection grezza → riepilogo per la pagina admin, o null se non è valida. */
export function toAudioComCollectionSummary(
  raw: unknown,
  featured: ReadonlySet<string>,
): AudioComCollectionSummary | null {
  const parsed = RawCollectionSchema.safeParse(raw);
  if (!parsed.success) return null;
  const collection = parsed.data;
  const title = cleanText(collection.title, 300);
  if (!AUDIOCOM_ID_PATTERN.test(collection.id) || !title) return null;
  return {
    id: collection.id,
    title,
    type: cleanText(collection.type, 40).toLowerCase(),
    itemsCount: collection.items_count ?? 0,
    listed: collection.is_listed !== false,
    imageUrl: audioComImageUrl(collection.image),
    featured: featured.has(collection.id),
  };
}

/** Corpo di /v1/collection/list → collection valide (null se il corpo non è un elenco). */
export function parseAudioComCollectionList(
  body: unknown,
  featured: ReadonlySet<string>,
): AudioComCollectionSummary[] | null {
  if (!Array.isArray(body)) return null;
  const seen = new Set<string>();
  const collections: AudioComCollectionSummary[] = [];
  for (const raw of body) {
    const summary = toAudioComCollectionSummary(raw, featured);
    if (!summary || seen.has(summary.id)) continue;
    seen.add(summary.id);
    collections.push(summary);
    if (collections.length >= AUDIOCOM_COLLECTIONS_LIST_MAX) break;
  }
  return collections;
}

/**
 * Corpo di /v1/collection/items → brani musicali validi nell'ordine della collection (al massimo 50),
 * con le regole della ricerca (licenza, cover, brani non pubblici); null se il corpo non è un elenco.
 */
export function parseAudioComCollectionItems(body: unknown): AudioComTrack[] | null {
  if (!Array.isArray(body)) return null;
  const seen = new Set<string>();
  const tracks: AudioComTrack[] = [];
  for (const raw of body) {
    const track = toAudioComTrack({ type: 'audio', model: raw });
    if (!track || seen.has(track.id)) continue;
    seen.add(track.id);
    tracks.push(track);
    if (tracks.length >= AUDIOCOM_COLLECTION_TRACKS_MAX) break;
  }
  return tracks;
}

// ---------------------------------------------------------------------------------------------
// Scelta dell'amministratore (database)

type FeaturedStore = Pick<typeof prisma, 'audioComFeaturedCollection' | '$transaction'>;

/** Le collection mostrate in Home, nell'ordine (solo id ben formati, al massimo 6). */
export async function readFeaturedAudioComCollectionIds(
  db: FeaturedStore = prisma,
): Promise<string[]> {
  const rows = await db.audioComFeaturedCollection.findMany({
    orderBy: { position: 'asc' },
    select: { collectionId: true },
    take: AUDIOCOM_FEATURED_COLLECTIONS_MAX,
  });
  return rows.map((row) => row.collectionId).filter((id) => AUDIOCOM_ID_PATTERN.test(id));
}

/** Sostituisce la scelta (ordine = posizione) e svuota la cache delle sezioni. */
export async function saveFeaturedAudioComCollectionIds(
  collectionIds: readonly string[],
  adminId: string,
  db: FeaturedStore = prisma,
): Promise<void> {
  await db.$transaction([
    db.audioComFeaturedCollection.deleteMany({}),
    db.audioComFeaturedCollection.createMany({
      data: collectionIds.map((collectionId, position) => ({
        collectionId,
        position,
        addedBy: adminId,
      })),
    }),
  ]);
  clearAudioComSectionsCache();
}

// ---------------------------------------------------------------------------------------------
// Richieste ad audio.com

type Access = { token: string; version: number };
type Fetched =
  | { ok: true; body: unknown }
  | { ok: false; reason: 'rate_limited' | 'not_found' | 'unavailable' };

function collectionUrl(base: string, params: Record<string, string>): string {
  const url = new URL(base);
  url.search = new URLSearchParams(params).toString();
  return url.toString();
}

/** GET autenticato ad audio.com, dopo il limite globale condiviso con la ricerca. */
async function audioComGet(url: string, access: Access): Promise<Fetched> {
  const decision = await consumeRateLimit('audiocom.search.global', AUDIOCOM_RATE_LIMIT_IDENTITY);
  if (!decision.allowed) return { ok: false, reason: 'rate_limited' };
  const result = await audioComRequest(
    url,
    { headers: { authorization: `Bearer ${access.token}`, accept: 'application/json' } },
    REQUEST_TIMEOUT_MS,
    MAX_BODY_BYTES,
  );
  if (result.status === 401) {
    await markAudioComAccessRejected(access.version);
    await recordAudioComError('search_unauthorized');
    return { ok: false, reason: 'unavailable' };
  }
  if (result.status === 404) return { ok: false, reason: 'not_found' };
  if (result.status === 429) {
    await recordAudioComError('rate_limited');
    return { ok: false, reason: 'rate_limited' };
  }
  if (!result.ok) {
    await recordAudioComError('search_failed');
    return { ok: false, reason: 'unavailable' };
  }
  return { ok: true, body: result.body };
}

function logFailure(what: string, error: unknown): void {
  // biome-ignore lint/suspicious/noConsole: log del server col solo nome dell'errore (mai token).
  console.warn(`[audiocom] ${what}:`, error instanceof Error ? error.name : typeof error);
}

/** Le collection dell'account collegato per la pagina admin, con quelle già in Home. */
export async function listAudioComCollectionsForAdmin(): Promise<AudioComCollectionsAdminResponse> {
  const featuredIds = await readFeaturedAudioComCollectionIds();
  const featured = new Set(featuredIds);
  try {
    const access = await getAudioComAccessToken();
    if (!access.ok) {
      return {
        status: access.reason === 'disconnected' ? 'disconnected' : 'unavailable',
        collections: [],
        featuredIds,
      };
    }
    const fetched = await audioComGet(
      collectionUrl(AUDIOCOM_COLLECTION_LIST_URL, {
        page: '1',
        'per-page': String(AUDIOCOM_COLLECTIONS_LIST_MAX),
      }),
      access,
    );
    if (!fetched.ok) return { status: 'unavailable', collections: [], featuredIds };
    const collections = parseAudioComCollectionList(fetched.body, featured);
    if (!collections) {
      await recordAudioComError('invalid_response');
      return { status: 'unavailable', collections: [], featuredIds };
    }
    return { status: 'ok', collections, featuredIds };
  } catch (error) {
    logFailure('elenco delle collection non riuscito', error);
    return { status: 'unavailable', collections: [], featuredIds };
  }
}

// ---------------------------------------------------------------------------------------------
// Sezioni della Home (in cache)

class SectionsUnavailable extends Error {
  constructor(readonly reason: string) {
    super(`audio.com: ${reason}`);
    this.name = 'SectionsUnavailable';
  }
}

async function buildSections(): Promise<AudioComHomeSection[]> {
  const ids = await readFeaturedAudioComCollectionIds();
  if (ids.length === 0) return [];
  const access = await getAudioComAccessToken();
  // Nessun account collegato: nessuna sezione (non è un problema da riprovare).
  if (!access.ok && access.reason === 'disconnected') return [];
  if (!access.ok) throw new SectionsUnavailable('token');
  const sections: AudioComHomeSection[] = [];
  // Una collection alla volta: poche richieste, sempre dentro il limite globale.
  for (const id of ids) {
    const view = await audioComGet(collectionUrl(AUDIOCOM_COLLECTION_VIEW_URL, { id }), access);
    if (!view.ok) {
      // Collection cancellata su audio.com: si salta, le altre restano.
      if (view.reason === 'not_found') continue;
      throw new SectionsUnavailable(view.reason);
    }
    const summary = toAudioComCollectionSummary(view.body, new Set());
    if (!summary) continue;
    const items = await audioComGet(
      collectionUrl(AUDIOCOM_COLLECTION_ITEMS_URL, {
        id,
        page: '1',
        'per-page': String(AUDIOCOM_COLLECTION_TRACKS_MAX),
      }),
      access,
    );
    if (!items.ok) {
      if (items.reason === 'not_found') continue;
      throw new SectionsUnavailable(items.reason);
    }
    const tracks = parseAudioComCollectionItems(items.body);
    if (!tracks) {
      await recordAudioComError('invalid_response');
      throw new SectionsUnavailable('invalid_response');
    }
    const section = AudioComHomeSectionSchema.safeParse({
      id: summary.id,
      title: summary.title,
      imageUrl: summary.imageUrl,
      tracks,
    });
    if (section.success) sections.push(section.data);
  }
  return sections;
}

type SectionsCache = { sections: AudioComHomeSection[]; expiresAt: number; builtAt: number };

let sectionsCache: SectionsCache | null = null;
let building: Promise<AudioComHomeSection[]> | null = null;
let generation = 0;

/** Svuota la cache delle sezioni (scelta cambiata, collega/scollega, test). */
export function clearAudioComSectionsCache(): void {
  sectionsCache = null;
  building = null;
  generation += 1;
}

/**
 * Le sezioni «In evidenza da audio.com» della Home. Non lancia mai: senza scelta o senza account
 * collegato → []; con audio.com che non risponde → le ultime sezioni buone (al più un'ora) o [].
 */
export function getAudioComHomeSections(now = Date.now()): Promise<AudioComHomeSection[]> {
  if (sectionsCache && sectionsCache.expiresAt > now) {
    return Promise.resolve(sectionsCache.sections);
  }
  if (building) return building;
  const started = generation;
  const previous = sectionsCache;
  const task = buildSections()
    .then((sections) => {
      if (started === generation) {
        const at = Date.now();
        sectionsCache = { sections, expiresAt: at + AUDIOCOM_SECTIONS_TTL_MS, builtAt: at };
      }
      return sections;
    })
    .catch((error: unknown) => {
      logFailure('sezioni della Home non aggiornate', error);
      const at = Date.now();
      const stale =
        previous && at - previous.builtAt < AUDIOCOM_SECTIONS_STALE_MAX_MS ? previous : null;
      const sections = stale?.sections ?? [];
      if (started === generation) {
        sectionsCache = {
          sections,
          expiresAt: at + AUDIOCOM_SECTIONS_RETRY_MS,
          builtAt: stale?.builtAt ?? at,
        };
      }
      return sections;
    })
    .finally(() => {
      if (building === task) building = null;
    });
  building = task;
  return task;
}

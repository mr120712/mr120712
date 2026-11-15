// @polsia:user-owned — registro sul dispositivo delle COPIE OFFLINE dei "brani in evidenza"
// («Scarica offline»). Per ogni copia salvata in «La tua musica» tiene l'id della libreria (UUID
// casuale), l'id opaco del brano (shareId, lo stesso del link diretto: mai il percorso nello store)
// e l'attribuzione da mostrare (titolare, licenza, link alla licenza).
//
// Perché un registro a parte: la libreria sul dispositivo (src/lib/local-music) salva il file e la
// fonte 'featured-download' così come sono, ma oggi rilegge come file locali le fonti che non
// conosce e non espone la chiave del download. Senza questo registro una copia non si potrebbe
// né attribuire né REVOCARE: per questo, se il registro non è scrivibile, la copia non si salva
// (fail closed, vedi offline-download.ts) e la verifica delle copie (featured-offline-sync.ts)
// lo usa come elenco delle copie da controllare.
//
// Solo localStorage, nessuna rete: si legge anche offline (lo usa «La tua musica», che non fa mai
// richieste, e il player per attribuire le copie e non mostrarne mai il testo). Voci rovinate o di
// versioni future si scartano in lettura; un registro intero illeggibile (JSON rovinato) non si
// sovrascrive mai: le nuove copie non si salvano (fail closed) invece di perdere le vecchie.
import type { OfflineAttribution } from '@/lib/contracts/offline';

/** La fonte delle copie dei brani in evidenza (salvata nel record della libreria). */
export const FEATURED_OFFLINE_SOURCE = 'featured-download';

/** Chiave del registro in localStorage (versionata). */
export const FEATURED_OFFLINE_COPIES_KEY = 'solco:featured-offline-copies:v1';

/** Copie al massimo nel registro (la libreria sul dispositivo ne contiene comunque poche). */
export const FEATURED_OFFLINE_COPIES_MAX = 2000;

const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const LOCAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Una copia offline di un brano in evidenza salvata su questo dispositivo. */
export type FeaturedOfflineCopy = {
  /** Id del brano nella libreria sul dispositivo. */
  localId: string;
  /** Id opaco del brano in evidenza (shareId). */
  featuredId: string;
  /** Attribuzione salvata con la copia (null se il server non ne ha mandata). */
  attribution: OfflineAttribution | null;
  /** Quando è stata salvata (epoch ms). */
  savedAt: number;
};

/** Il minimo di Storage che serve (window.localStorage, o uno finto nei test). */
export type CopyStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): CopyStorage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    // Accesso negato (dati del sito bloccati): nessun registro.
    return null;
  }
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

function httpsUrl(value: unknown): string | null {
  const raw = text(value, 2048);
  if (!raw) return null;
  try {
    return new URL(raw).protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
}

function readAttribution(value: unknown): OfflineAttribution | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  const attribution: OfflineAttribution = {
    sourceName: text(r.sourceName, 300),
    sourceUrl: httpsUrl(r.sourceUrl),
    licenseName: text(r.licenseName, 200),
    licenseUrl: httpsUrl(r.licenseUrl),
    creditLine: text(r.creditLine, 500),
  };
  return Object.values(attribution).some((entry) => entry !== null) ? attribution : null;
}

function readCopy(value: unknown): FeaturedOfflineCopy | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  if (typeof r.localId !== 'string' || !LOCAL_ID_PATTERN.test(r.localId)) return null;
  if (typeof r.featuredId !== 'string' || !ID_PATTERN.test(r.featuredId)) return null;
  return {
    localId: r.localId,
    featuredId: r.featuredId,
    attribution: readAttribution(r.attribution),
    savedAt: typeof r.savedAt === 'number' && Number.isFinite(r.savedAt) ? r.savedAt : 0,
  };
}

/**
 * Il registro com'è: 'empty' se non c'è ancora, 'ok' con le copie valide, 'unreadable' se c'è ma
 * non si legge (JSON rovinato, forma sconosciuta o accesso negato). Un registro illeggibile non si
 * sovrascrive mai: perderebbe le copie già salvate, che non si potrebbero più revocare.
 */
function readRegistry(storage: CopyStorage): {
  state: 'empty' | 'ok' | 'unreadable';
  copies: FeaturedOfflineCopy[];
} {
  let raw: string | null;
  try {
    raw = storage.getItem(FEATURED_OFFLINE_COPIES_KEY);
  } catch {
    return { state: 'unreadable', copies: [] };
  }
  if (!raw) return { state: 'empty', copies: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: 'unreadable', copies: [] };
  }
  const rows =
    typeof parsed === 'object' &&
    parsed !== null &&
    Array.isArray((parsed as { copies?: unknown }).copies)
      ? (parsed as { copies: unknown[] }).copies
      : null;
  if (!rows) return { state: 'unreadable', copies: [] };
  const seen = new Set<string>();
  const copies: FeaturedOfflineCopy[] = [];
  for (const row of rows.slice(0, FEATURED_OFFLINE_COPIES_MAX)) {
    const copy = readCopy(row);
    if (!copy || seen.has(copy.localId)) continue;
    seen.add(copy.localId);
    copies.push(copy);
  }
  return { state: 'ok', copies };
}

/** Le copie registrate su questo dispositivo (vuoto se il registro manca o non si legge). */
export function readFeaturedCopies(
  storage: CopyStorage | null = defaultStorage(),
): FeaturedOfflineCopy[] {
  return storage ? readRegistry(storage).copies : [];
}

/** Ultimo registro letto da featuredCopyFor (stesso testo = stessa mappa, senza rileggere il JSON). */
let lookupCache: { raw: string; byLocalId: Map<string, FeaturedOfflineCopy> } | null = null;

/**
 * La copia di un brano in evidenza registrata per questo id della libreria, o null. Leggera: il
 * player la chiede a ogni brano locale (attribuzione, niente pannello "Testo"), quindi il JSON si
 * rilegge solo quando il registro cambia.
 */
export function featuredCopyFor(
  localId: string,
  storage: CopyStorage | null = defaultStorage(),
): FeaturedOfflineCopy | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(FEATURED_OFFLINE_COPIES_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  if (lookupCache?.raw !== raw) {
    lookupCache = {
      raw,
      byLocalId: new Map(readRegistry(storage).copies.map((copy) => [copy.localId, copy] as const)),
    };
  }
  return lookupCache.byLocalId.get(localId) ?? null;
}

/** Evento di finestra dopo ogni copia registrata (la verifica dei permessi parte anche da qui). */
export const FEATURED_OFFLINE_COPIES_CHANGED_EVENT = 'solco:featured-offline-copies-changed';

function announceChange(): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  try {
    window.dispatchEvent(new Event(FEATURED_OFFLINE_COPIES_CHANGED_EVENT));
  } catch {
    // Un browser senza Event funzionale: la verifica partirà al prossimo caricamento.
  }
}

function writeCopies(copies: readonly FeaturedOfflineCopy[], storage: CopyStorage): boolean {
  try {
    if (copies.length === 0) storage.removeItem(FEATURED_OFFLINE_COPIES_KEY);
    else storage.setItem(FEATURED_OFFLINE_COPIES_KEY, JSON.stringify({ v: 1, copies }));
    return true;
  } catch {
    // Spazio esaurito o accesso negato.
    return false;
  }
}

/**
 * True se il registro si può scrivere su questo dispositivo (e non è illeggibile): senza, una copia
 * non sarebbe revocabile, quindi «Scarica offline» non salva nulla (e non consuma i download del
 * giorno).
 */
export function canRememberFeaturedCopies(storage: CopyStorage | null = defaultStorage()): boolean {
  if (!storage || readRegistry(storage).state === 'unreadable') return false;
  const probe = `${FEATURED_OFFLINE_COPIES_KEY}:probe`;
  try {
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/** Registra una copia appena salvata. false = il registro non si scrive (la copia va tolta). */
export function rememberFeaturedCopy(
  copy: FeaturedOfflineCopy,
  storage: CopyStorage | null = defaultStorage(),
): boolean {
  if (!storage || !readCopy(copy)) return false;
  const registry = readRegistry(storage);
  // Registro illeggibile: non si sovrascrive (le copie già salvate resterebbero senza revoca).
  if (registry.state === 'unreadable') return false;
  const others = registry.copies.filter((item) => item.localId !== copy.localId);
  if (others.length >= FEATURED_OFFLINE_COPIES_MAX) return false;
  const written = writeCopies([...others, copy], storage);
  if (written) announceChange();
  return written;
}

/** Toglie dal registro le copie con questi id della libreria (rimosse o revocate). */
export function forgetFeaturedCopies(
  localIds: Iterable<string>,
  storage: CopyStorage | null = defaultStorage(),
): boolean {
  if (!storage) return false;
  const drop = new Set(localIds);
  if (drop.size === 0) return true;
  const registry = readRegistry(storage);
  if (registry.state === 'unreadable') return false;
  const kept = registry.copies.filter((copy) => !drop.has(copy.localId));
  return kept.length === registry.copies.length ? true : writeCopies(kept, storage);
}

/** Le copie registrate per id della libreria (per «La tua musica»). */
export function featuredCopiesByLocalId(
  storage: CopyStorage | null = defaultStorage(),
): Map<string, FeaturedOfflineCopy> {
  return new Map(readFeaturedCopies(storage).map((copy) => [copy.localId, copy] as const));
}

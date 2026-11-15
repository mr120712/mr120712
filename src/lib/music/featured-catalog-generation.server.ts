// @polsia:user-owned — contatore condiviso (database) dei "brani in evidenza": il pulsante «Aggiorna
// ora» della pagina admin «Diritti e testi» lo incrementa e ogni istanza del server lo rilegge al
// massimo ogni ~10 secondi (cache in memoria). Quando cambia, la versione del catalogo
// (featured-catalog.server) cambia anche lei e l'istanza rielenca subito lo store: le modifiche
// fatte nel pannello Vercel Blob compaiono ovunque entro pochi secondi, senza aspettare la finestra
// normale (~30 secondi). Una sola riga ("singleton"), nessun dato utente.
//
// Costo: al massimo una lettura per chiave primaria ogni ~10 secondi per istanza, SOLO quando
// arrivano richieste (nessun timer: un'istanza ferma non interroga niente). Non fa mai throw in
// lettura: database non configurato, tabella non ancora creata o lento → si tiene l'ultimo valore
// noto, così la Home non si rompe mai per questo.
//
// Istanza appena avviata e prima lettura fallita (connessione a freddo lenta): il valore NON è
// noto. Lo si dice (`known: false`), così la versione che ne nasce non va nella cache della CDN, e
// si riprova dopo ~1 secondo invece di tenere 0 per ~10 secondi (altrimenti l'istanza pubblicava
// una versione "contatore 0" e la cambiava poco dopo). Dopo alcuni tentativi falliti di fila si
// accetta l'ultimo valore noto (0) come buono, per non restare provvisori finché il database non
// torna.
import 'server-only';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';

/** Il contatore letto si riusa per ~10 secondi: le altre istanze vedono un «Aggiorna ora» entro tanto. */
export const GENERATION_TTL_MS = 10_000;
/** Attesa massima della lettura: oltre, si usa l'ultimo valore noto (la richiesta non aspetta il DB). */
const GENERATION_READ_DEADLINE_MS = 1500;
/** Valore non ancora noto (nessuna lettura riuscita): si riprova dopo ~1 secondo. */
export const GENERATION_RETRY_MS = 1000;
/** Dopo tanti tentativi falliti di fila senza alcun valore letto, 0 vale come noto. */
const GENERATION_UNKNOWN_ATTEMPTS = 3;
const SINGLETON_ID = 'singleton';

/** Il contatore e se è davvero noto (false = nessuna lettura riuscita: versione provvisoria). */
export type FeaturedCatalogGeneration = { generation: number; known: boolean };

let known: { generation: number; checkedAt: number; certain: boolean } | null = null;
let reading: Promise<FeaturedCatalogGeneration> | null = null;
/** Letture fallite di fila senza alcun valore noto. */
let failedAttempts = 0;
/** Cambia a ogni svuotamento o incremento: una lettura partita prima non scrive più nella cache. */
let epoch = 0;

/** Svuota la cache del contatore (solo per i test). */
export function clearFeaturedCatalogGenerationForTests() {
  known = null;
  reading = null;
  failedAttempts = 0;
  epoch += 1;
}

/** Il contatore dal database entro la scadenza; null se non risponde, è in errore o manca la tabella. */
async function readWithin(ms: number): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  const lookup = (async () => {
    try {
      const row = await prisma.featuredCatalogState.findUnique({
        where: { id: SINGLETON_ID },
        select: { generation: true },
      });
      return row?.generation ?? 0;
    } catch {
      return null;
    }
  })();
  try {
    return await Promise.race([lookup, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Il contatore attuale e se è noto: dalla cache (~10 secondi; ~1 secondo finché non è noto),
 * altrimenti riletto UNA volta anche con più richieste insieme. Non scende mai (si tiene il massimo
 * visto). Mai throw.
 */
export async function readFeaturedCatalogGeneration(): Promise<FeaturedCatalogGeneration> {
  if (known) {
    const ttl = known.certain ? GENERATION_TTL_MS : GENERATION_RETRY_MS;
    if (Date.now() - known.checkedAt < ttl) {
      return { generation: known.generation, known: known.certain };
    }
  }
  // Senza database (es. test, ambiente locale) nessuna lettura: il catalogo segue solo lo store.
  if (!env.DATABASE_URL) return { generation: known?.generation ?? 0, known: true };
  if (!reading) {
    const started = epoch;
    const current: Promise<FeaturedCatalogGeneration> = readWithin(GENERATION_READ_DEADLINE_MS)
      .then((value): FeaturedCatalogGeneration => {
        failedAttempts = value === null ? failedAttempts + 1 : 0;
        const generation = Math.max(value ?? 0, known?.generation ?? 0);
        // Noto: letto ora, già letto in passato (resta il massimo visto: dopo un errore si aspetta
        // la finestra normale, niente martellamento di un database lento) o troppi tentativi falliti.
        const certain =
          value !== null ||
          known?.certain === true ||
          failedAttempts >= GENERATION_UNKNOWN_ATTEMPTS;
        if (started === epoch) known = { generation, checkedAt: Date.now(), certain };
        return { generation, known: certain };
      })
      .finally(() => {
        if (reading === current) reading = null;
      });
    reading = current;
  }
  return reading;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

async function incrementOnce(): Promise<number> {
  const now = new Date();
  const row = await prisma.featuredCatalogState.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID, generation: 1, bumpedAt: now },
    update: { generation: { increment: 1 }, bumpedAt: now },
    select: { generation: true },
  });
  return row.generation;
}

/**
 * «Aggiorna ora»: incrementa il contatore condiviso e lo tiene subito in cache su questa istanza
 * (che quindi rielenca lo store alla prossima richiesta). Fa throw se il database non risponde:
 * la route lo dice all'amministratore.
 */
export async function bumpFeaturedCatalogGeneration(): Promise<number> {
  let generation: number;
  try {
    generation = await incrementOnce();
  } catch (error) {
    // Due «Aggiorna ora» nello stesso istante sulla riga ancora da creare: il secondo la trova.
    if (!isUniqueViolation(error)) throw error;
    generation = await incrementOnce();
  }
  epoch += 1;
  reading = null;
  failedAttempts = 0;
  known = {
    generation: Math.max(generation, known?.generation ?? 0),
    checkedAt: Date.now(),
    certain: true,
  };
  return known.generation;
}

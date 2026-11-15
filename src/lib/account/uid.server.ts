// @polsia:user-owned — UID degli account (lato server): assegna l'UID leggibile (src/lib/account/
// uid.ts) agli utenti che non l'hanno ancora. Chi lo assegna:
// - l'avvio del server (src/lib/seed.ts): backfillAccountUids per gli account già esistenti;
// - su richiesta: ensureAccountUids quando un utente apre i dati del suo account o l'admin apre
//   «Gestione account», così anche un account nato dopo l'ultimo avvio ha subito il suo UID.
// Le scritture sono idempotenti (createMany con skipDuplicates): due istanze o due richieste in
// parallelo non creano doppioni; un UID già preso (collisione, in pratica mai) si riprova con un
// altro. La tabella non ha relazione con User (schema del modulo di autenticazione): la riga si
// cancella con l'account (account-deletion.ts).
import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { generateAccountUid } from '@/lib/account/uid';
import { prisma } from '@/lib/db';

export type UidDb = Pick<PrismaClient, 'userUid' | 'user'>;

/** Tentativi massimi per assegnare gli UID mancanti (ogni giro riprova solo le collisioni). */
const MAX_ATTEMPTS = 5;
/** Utenti per giro del backfill all'avvio. */
const BACKFILL_BATCH = 500;

async function readUids(db: UidDb, userIds: readonly string[], into: Map<string, string>) {
  const rows = await db.userUid.findMany({
    where: { userId: { in: [...userIds] } },
    select: { userId: true, uid: true },
  });
  for (const row of rows) into.set(row.userId, row.uid);
}

/**
 * L'UID di ognuno degli utenti `userIds` (id di account ESISTENTI), creato per chi non l'ha
 * ancora. Chi resta senza dopo i tentativi (collisioni ripetute: in pratica mai) manca dalla mappa.
 * `generate` si cambia solo nei test.
 */
export async function ensureAccountUids(
  userIds: readonly string[],
  db: UidDb = prisma,
  generate: () => string = () => generateAccountUid(),
): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((id) => typeof id === 'string' && id.length > 0))];
  const uids = new Map<string, string>();
  if (ids.length === 0) return uids;
  await readUids(db, ids, uids);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const missing = ids.filter((id) => !uids.has(id));
    if (missing.length === 0) break;
    // skipDuplicates: un utente già servito da un'altra richiesta o un UID già preso si saltano;
    // si rilegge e si riprova solo chi manca ancora.
    await db.userUid.createMany({
      data: missing.map((userId) => ({ userId, uid: generate() })),
      skipDuplicates: true,
    });
    await readUids(db, missing, uids);
  }
  return uids;
}

/** L'UID di un utente (creato se manca); null solo se non si riesce ad assegnarlo. */
export async function ensureAccountUid(userId: string, db: UidDb = prisma): Promise<string | null> {
  return (await ensureAccountUids([userId], db)).get(userId) ?? null;
}

/**
 * All'avvio: assegna l'UID a tutti gli account che non l'hanno, a gruppi. Se gli UID sono già
 * tanti quanti gli account, esce subito (due conteggi). Restituisce quanti UID ha creato.
 */
export async function backfillAccountUids(db: UidDb = prisma): Promise<number> {
  const [users, existing] = await Promise.all([db.user.count(), db.userUid.count()]);
  if (existing >= users) return 0;
  let created = 0;
  let cursor: string | undefined;
  for (;;) {
    const batch = await db.user.findMany({
      select: { id: true },
      orderBy: { id: 'asc' },
      take: BACKFILL_BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (batch.length === 0) break;
    const ids = batch.map((user) => user.id);
    const before = await db.userUid.count({ where: { userId: { in: ids } } });
    const after = await ensureAccountUids(ids, db);
    created += Math.max(0, after.size - before);
    cursor = ids[ids.length - 1];
    if (batch.length < BACKFILL_BATCH) break;
  }
  return created;
}

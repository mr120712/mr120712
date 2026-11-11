// @polsia:user-owned
import 'server-only';
import { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import {
  CreatedListeningEntryResponseSchema,
  CreateListeningEntrySchema,
  ListeningEntryListSchema,
} from '@/lib/contracts/music';
import { prisma } from '@/lib/db';
import {
  createListeningUsage,
  FREE_MONTHLY_LISTEN_LIMIT,
  getListeningCalendarMonth,
} from '@/lib/music/listening-quota';
import { requireAuth, type SessionUser } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';
const MAX_SERIALIZATION_ATTEMPTS = 8;
// Note (2,000 characters) plus short catalogue metadata; leaves room for multi-byte text.
const MAX_BODY_BYTES = 16 * 1024;
const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

// The shared contract does not bound these catalogue fields, but they are stored in the diary.
const CreateListeningEntryRequestSchema = CreateListeningEntrySchema.extend({
  releaseDate: z.string().max(64).nullable(),
  genre: z.string().max(100).nullable(),
});

function isSerializationConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2034';
}

function retryDelay(attempt: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 5 * 2 ** attempt + Math.floor(Math.random() * 10));
  });
}

function serializeEntry(entry: {
  id: string;
  albumId: string;
  catalogProvider: string;
  albumName: string;
  artistName: string;
  artworkUrl: string | null;
  releaseDate: string | null;
  genre: string | null;
  trackCount: number | null;
  storeUrl: string | null;
  rating: number;
  note: string;
  listenedOn: Date;
  context: string | null;
  createdAt: Date;
}) {
  return {
    id: entry.id,
    albumId: entry.albumId,
    catalogProvider: entry.catalogProvider,
    albumName: entry.albumName,
    artistName: entry.artistName,
    artworkUrl: null,
    releaseDate: entry.releaseDate,
    genre: entry.genre,
    trackCount: entry.trackCount,
    storeUrl: entry.storeUrl,
    rating: entry.rating,
    note: entry.note,
    listenedOn: entry.listenedOn.toISOString().slice(0, 10),
    context: entry.context,
    createdAt: entry.createdAt.toISOString(),
  };
}

export async function GET(request: Request) {
  let user: SessionUser;
  try {
    user = await requireAuth(request);
  } catch (response) {
    return response as Response;
  }

  try {
    const entries = await prisma.listeningEntry.findMany({
      where: { userId: user.id },
      orderBy: [{ listenedOn: 'desc' }, { createdAt: 'desc' }],
    });
    return NextResponse.json(
      ListeningEntryListSchema.parse({ entries: entries.map(serializeEntry) }),
      { headers: privateHeaders },
    );
  } catch {
    return NextResponse.json(
      { error: 'Non è stato possibile caricare il diario.' },
      { status: 500, headers: privateHeaders },
    );
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: 'Origine della richiesta non valida.' }, { status: 403 });
  }

  let user: SessionUser;
  try {
    user = await requireAuth(request);
  } catch (response) {
    return response as Response;
  }

  const payload = await readJsonLimited(request, MAX_BODY_BYTES);
  if (!payload.ok) return limitedJsonError(payload);
  const parsed = CreateListeningEntryRequestSchema.safeParse(payload.value);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Controlla voto, nota e data.' }, { status: 400 });
  }

  const limited = await enforceRateLimit(
    'listening.write',
    getRateLimitIdentity(user.id, request.headers),
  );
  if (limited) return limited;

  try {
    for (let attempt = 0; attempt < MAX_SERIALIZATION_ATTEMPTS; attempt += 1) {
      try {
        const outcome = await prisma.$transaction(
          async (transaction) => {
            const createdAt = new Date();
            const month = getListeningCalendarMonth(createdAt);
            const used = await transaction.listeningEntry.count({
              where: {
                userId: user.id,
                createdAt: { gte: month.start, lt: month.end },
              },
            });
            const usage = createListeningUsage(used, createdAt);
            if (used >= FREE_MONTHLY_LISTEN_LIMIT) {
              return { kind: 'limit' as const, usage };
            }

            const entry = await transaction.listeningEntry.create({
              data: {
                ...parsed.data,
                artworkUrl: null,
                context: parsed.data.context?.trim() || null,
                listenedOn: new Date(`${parsed.data.listenedOn}T12:00:00.000Z`),
                createdAt,
                userId: user.id,
              },
            });
            return {
              kind: 'created' as const,
              entry,
              usage: createListeningUsage(used + 1, createdAt),
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );

        if (outcome.kind === 'limit') {
          return NextResponse.json(
            {
              error: `Hai raggiunto il limite di ${FREE_MONTHLY_LISTEN_LIMIT} ascolti registrati in questo mese. Potrai aggiungerne altri dal mese prossimo.`,
              usage: outcome.usage,
            },
            { status: 409 },
          );
        }

        return NextResponse.json(
          CreatedListeningEntryResponseSchema.parse({
            entry: serializeEntry(outcome.entry),
            usage: outcome.usage,
          }),
          { status: 201 },
        );
      } catch (error) {
        if (!isSerializationConflict(error)) throw error;
        if (attempt === MAX_SERIALIZATION_ATTEMPTS - 1) {
          return NextResponse.json(
            { error: 'Il diario è molto richiesto. Riprova tra qualche secondo.' },
            { status: 503 },
          );
        }
        await retryDelay(attempt);
      }
    }

    return NextResponse.json(
      { error: 'Non è stato possibile salvare l’ascolto. Riprova.' },
      { status: 503 },
    );
  } catch {
    return NextResponse.json(
      { error: 'Non è stato possibile salvare l’ascolto.' },
      { status: 500 },
    );
  }
}

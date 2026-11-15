// @polsia:user-owned — «In evidenza da audio.com» nella pagina admin /admin/audiocom:
// - GET: le collection dell'account audio.com collegato e quelle già mostrate in Home;
// - PUT (stessa origine): le collection da mostrare in Home, nell'ordine (al massimo 6, tutte
//   dell'account collegato). Svuota la cache delle sezioni: la Home cambia entro pochi minuti
//   (cache della rete compresa).
// Solo amministratori con email verificata (requireAudioComAdmin); risposte mai in cache; nei log
// solo il nome dell'errore.
import 'server-only';
import { NextResponse } from 'next/server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import {
  AudioComCollectionsAdminResponseSchema,
  AudioComFeaturedInputSchema,
} from '@/lib/contracts/audiocom-collections';
import { audioComPrivateHeaders, requireAudioComAdmin } from '@/lib/music/audiocom-admin.server';
import {
  listAudioComCollectionsForAdmin,
  saveFeaturedAudioComCollectionIds,
} from '@/lib/music/audiocom-collections.server';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: audioComPrivateHeaders });
}

function logFailure(what: string, error: unknown) {
  // biome-ignore lint/suspicious/noConsole: log del server col solo nome dell'errore (mai token).
  console.error(
    `[admin/audiocom/collections] ${what}:`,
    error instanceof Error ? error.name : typeof error,
  );
}

export async function GET(request: Request) {
  const access = await requireAudioComAdmin(request);
  if (!access.allowed) return access.response;
  try {
    return json(
      AudioComCollectionsAdminResponseSchema.parse(await listAudioComCollectionsForAdmin()),
    );
  } catch (error) {
    logFailure('elenco non disponibile', error);
    return json(
      {
        error: 'audiocom_collections_unavailable',
        message:
          'Le collection di audio.com non sono disponibili in questo momento. Riprova tra poco.',
      },
      500,
    );
  }
}

export async function PUT(request: Request) {
  if (!sameOrigin(request)) return json({ error: 'forbidden_origin' }, 403);
  const access = await requireAudioComAdmin(request);
  if (!access.allowed) return access.response;

  const payload = await readJsonLimited(request, 4_096);
  if (!payload.ok) return limitedJsonError(payload);
  const input = AudioComFeaturedInputSchema.safeParse(payload.value);
  if (!input.success) {
    const message = input.error.issues[0]?.message ?? 'Scelta non valida.';
    return json({ errors: { collectionIds: message } }, 400);
  }

  try {
    // Solo collection dell'account collegato: si ricontrolla l'elenco di audio.com.
    const current = await listAudioComCollectionsForAdmin();
    if (current.status !== 'ok') {
      return json(
        {
          error: 'audiocom_unavailable',
          message:
            current.status === 'disconnected'
              ? 'Collega prima l’account audio.com.'
              : 'audio.com non risponde in questo momento: riprova tra poco.',
        },
        503,
      );
    }
    const owned = new Set(current.collections.map((collection) => collection.id));
    if (!input.data.collectionIds.every((id) => owned.has(id))) {
      return json(
        { errors: { collectionIds: 'Una collection non è (più) nel tuo account audio.com.' } },
        400,
      );
    }
    await saveFeaturedAudioComCollectionIds(input.data.collectionIds, access.userId);
    const featured = new Set(input.data.collectionIds);
    return json(
      AudioComCollectionsAdminResponseSchema.parse({
        status: 'ok',
        collections: current.collections.map((collection) => ({
          ...collection,
          featured: featured.has(collection.id),
        })),
        featuredIds: input.data.collectionIds,
      }),
    );
  } catch (error) {
    logFailure('salvataggio non riuscito', error);
    return json(
      {
        error: 'audiocom_featured_save_failed',
        message: 'Non è stato possibile salvare la scelta. Riprova tra poco.',
      },
      500,
    );
  }
}

// @polsia:user-owned — POST /api/admin/legacy-users/import: anteprima ({action:'preview', source})
// e trasferimento a lotti ({action:'import', source, previewToken}) degli account di un vecchio
// database nel database attuale. Stessa origine prima di tutto (403), poi admin con email
// verificata (401/403), corpo validato con zod (400), limite di frequenza su un bucket admin
// esistente. 409 per un'anteprima scaduta, non valida o superata da account nuovi; 503 se il
// vecchio database non risponde. Nessuna risposta o log contiene URL, host, email o hash.
import 'server-only';
import { NextResponse } from 'next/server';
import { importLegacyBatch, previewLegacyImport } from '@/lib/admin/legacy-users.server';
import {
  failure,
  legacyFailureResponse,
  legacyRateLimit,
  privateHeaders,
  requireLegacyAdmin,
} from '@/lib/admin/legacy-users-route.server';
import {
  LegacyImportPostResponseSchema,
  LegacyImportRequestSchema,
} from '@/lib/contracts/legacy-users';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';
// Lettura del vecchio database + un lotto di 200 account in transazione.
export const maxDuration = 60;

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return failure(
      'forbidden_origin',
      403,
      'Richiesta rifiutata per sicurezza: ricarica la pagina e riprova.',
    );
  }
  const access = await requireLegacyAdmin(request);
  if (!access.allowed) return access.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return failure('invalid_body', 400, 'Richiesta non valida.');
  }
  const parsed = LegacyImportRequestSchema.safeParse(raw);
  if (!parsed.success) return failure('invalid_body', 400, 'Richiesta non valida.');

  // Bucket admin esistente (20 al minuto, 100 all'ora), con un'identità propria: basta per
  // anteprima e molti «Continua» di fila.
  const limited = await legacyRateLimit(
    'admin.assistant',
    `legacy-users-import:user:${access.userId}`,
  );
  if (limited) return limited;

  try {
    const body = parsed.data;
    const result =
      body.action === 'preview'
        ? await previewLegacyImport(body.source)
        : await importLegacyBatch(body.source, body.previewToken);
    if (!result.ok) return legacyFailureResponse(result.failure);
    return NextResponse.json(LegacyImportPostResponseSchema.parse(result.value), {
      headers: privateHeaders,
    });
  } catch (error) {
    // biome-ignore lint/suspicious/noConsole: log del server col solo nome dell'errore.
    console.error(
      '[admin/legacy-users/import] operazione non riuscita:',
      error instanceof Error ? error.name : typeof error,
    );
    return failure(
      'legacy_import_failed',
      500,
      'Operazione non riuscita. Gli account già trasferiti restano: riprova tra poco.',
    );
  }
}

// @polsia:user-owned

import 'server-only';
import {
  authorizeCorrectionScope,
  authorizeCsvExport,
  csvExportSources,
} from '@/lib/csv-export/sources.server';
import { sameOrigin } from '@/lib/same-origin';
import { siteUrl } from '@/lib/site';
import { createCsvExportHandlers } from '@/modules/csv-export/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const handlers = createCsvExportHandlers({
  sources: csvExportSources,
  authorize: authorizeCsvExport,
  allowedOrigin: new URL(siteUrl).origin,
});
export const GET = handlers.GET;
export async function POST(request: Request) {
  if (!sameOrigin(request))
    return Response.json(
      { ok: false, error: { code: 'FORBIDDEN', message: 'Richiesta non valida.' } },
      { status: 403 },
    );
  const scopeFailure = await authorizeCorrectionScope(request);
  if (scopeFailure) return scopeFailure;
  return handlers.POST(request);
}

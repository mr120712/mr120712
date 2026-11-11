// @polsia:user-owned
import 'server-only';

import { auth } from '@/lib/auth';
import { updateLinkCheck } from '@/lib/business/product-check';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import { productCheckResponseSchema, productCheckResultSchema } from '@/lib/contracts/workspace';
import { prisma } from '@/lib/db';
import { sameOrigin } from '@/lib/same-origin';
import {
  fetchPage,
  InvalidUrlError,
  PageUnavailableError,
  QuotaExceededError,
  WebSearchConfigurationError,
  WebSearchError,
  WebSearchNotEnabledError,
  WebSearchUnavailableError,
} from '@/modules/web-search/client';

function failureFor(error: unknown): { message: string; status: number } {
  if (error instanceof WebSearchNotEnabledError)
    return { message: 'La lettura web non è attiva per questa azienda.', status: 503 };
  if (error instanceof QuotaExceededError)
    return {
      message: 'È stato raggiunto il limite giornaliero di letture web. Puoi riprendere più tardi.',
      status: 429,
    };
  if (error instanceof InvalidUrlError)
    return { message: 'Questo collegamento non può essere letto dal servizio web.', status: 400 };
  if (error instanceof WebSearchUnavailableError || error instanceof WebSearchConfigurationError) {
    return {
      message: 'La lettura web non è disponibile in questo momento. Puoi riprendere più tardi.',
      status: 503,
    };
  }
  if (error instanceof WebSearchError)
    return {
      message: 'La richiesta di lettura web non è stata accettata.',
      status: error.status >= 400 && error.status < 500 ? error.status : 503,
    };
  return { message: 'Non è stato possibile leggere questo collegamento.', status: 503 };
}

export async function POST(request: Request, { params }: { params: Promise<{ checkId: string }> }) {
  if (!sameOrigin(request))
    return Response.json({ error: 'Richiesta non valida.' }, { status: 403 });
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user)
    return Response.json({ error: 'Accedi per continuare il controllo.' }, { status: 401 });
  const body = await readJsonLimited(request, 1024);
  if (!body.ok) return limitedJsonError(body);
  if (
    typeof body.value !== 'object' ||
    body.value === null ||
    Array.isArray(body.value) ||
    Object.keys(body.value).length !== 0
  ) {
    return Response.json(
      { error: 'invalid_request', message: 'La richiesta del controllo non è valida.' },
      { status: 400 },
    );
  }
  const { checkId } = await params;

  const check = await prisma.productCheck.findFirst({
    where: { id: checkId, userId: session.user.id, product: { shop: { userId: session.user.id } } },
    include: { product: { select: { updatedAt: true } } },
  });
  if (!check) return Response.json({ error: 'Controllo non trovato.' }, { status: 404 });
  const result = productCheckResultSchema.parse(check.result);
  const linkIndex = result.links.findIndex((link) => link.status === 'pending');
  if (linkIndex < 0) {
    const completed = await prisma.productCheck.update({
      where: { id: check.id },
      data: { status: 'completed', checkedAt: check.checkedAt ?? new Date() },
    });
    return Response.json(
      productCheckResponseSchema.parse({
        check: {
          id: completed.id,
          status: completed.status,
          createdAt: completed.createdAt.toISOString(),
          checkedAt: completed.checkedAt?.toISOString() ?? null,
          isCurrent: Boolean(completed.checkedAt && completed.checkedAt >= check.product.updatedAt),
          result,
        },
        remainingLinks: 0,
      }),
    );
  }

  const link = result.links[linkIndex];
  if (!link) return Response.json({ error: 'Collegamento non trovato.' }, { status: 409 });
  const limited = await enforceRateLimit('product.check.link', `user:${session.user.id}`);
  if (limited) return limited;
  let updated = result;
  let error: unknown;
  try {
    const page = await fetchPage({ url: link.url });
    if (!page.markdown.trim()) throw new PageUnavailableError();
    updated = updateLinkCheck(result, linkIndex, {
      readable: true,
      title: page.title || null,
      checkedAt: page.fetchedAt,
      reason: null,
    });
  } catch (caught) {
    error = caught;
    const unavailable = caught instanceof PageUnavailableError;
    updated = updateLinkCheck(result, linkIndex, {
      readable: false,
      title: null,
      checkedAt: new Date().toISOString(),
      reason: unavailable
        ? 'Il lettore web non ha restituito contenuto leggibile per questo collegamento.'
        : failureFor(caught).message,
    });
  }

  const remainingLinks = updated.links.filter((item) => item.status === 'pending').length;
  const stopForService = error !== undefined && !(error instanceof PageUnavailableError);
  const status = remainingLinks === 0 ? (stopForService ? 'failed' : 'completed') : 'in_progress';
  const saved = await prisma.productCheck.update({
    where: { id: check.id },
    data: {
      status,
      result: updated,
      checkedAt: remainingLinks === 0 ? new Date() : null,
    },
  });

  if (stopForService && error !== undefined) {
    const failure = failureFor(error);
    return Response.json({ error: failure.message, checkId: saved.id }, { status: failure.status });
  }

  return Response.json(
    productCheckResponseSchema.parse({
      check: {
        id: saved.id,
        status: saved.status,
        createdAt: saved.createdAt.toISOString(),
        checkedAt: saved.checkedAt?.toISOString() ?? null,
        isCurrent: Boolean(saved.checkedAt && saved.checkedAt >= check.product.updatedAt),
        result: updated,
      },
      remainingLinks,
    }),
  );
}

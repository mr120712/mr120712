// @polsia:user-owned
import 'server-only';

import { auth } from '@/lib/auth';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import {
  productCheckResultSchema,
  productDetailResponseSchema,
  updateProductRequestSchema,
} from '@/lib/contracts/workspace';
import { prisma } from '@/lib/db';
import { sameOrigin } from '@/lib/same-origin';

async function readOwnedProduct(productId: string, userId: string) {
  return prisma.product.findFirst({
    where: { id: productId, shop: { userId } },
    include: {
      shop: { select: { name: true } },
      checks: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });
}

function toResponse(product: NonNullable<Awaited<ReturnType<typeof readOwnedProduct>>>) {
  const latest = product.checks[0];
  return productDetailResponseSchema.parse({
    product: {
      id: product.id,
      shopId: product.shopId,
      shopName: product.shop.name,
      name: product.name,
      url: product.url,
      expectedPriceCents: product.expectedPriceCents,
      expectedAvailability: product.expectedAvailability,
      currency: 'EUR',
      createdAt: product.createdAt.toISOString(),
      updatedAt: product.updatedAt.toISOString(),
      latestCheck: latest
        ? {
            id: latest.id,
            status: latest.status,
            createdAt: latest.createdAt.toISOString(),
            checkedAt: latest.checkedAt?.toISOString() ?? null,
            isCurrent: Boolean(latest.checkedAt && latest.checkedAt >= product.updatedAt),
            result: productCheckResultSchema.parse(latest.result),
          }
        : null,
    },
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ productId: string }> },
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user)
    return Response.json({ error: 'Accedi per visualizzare il prodotto.' }, { status: 401 });
  const { productId } = await params;
  try {
    const product = await readOwnedProduct(productId, session.user.id);
    if (!product) return Response.json({ error: 'Prodotto non trovato.' }, { status: 404 });
    return Response.json(toResponse(product), { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ error: 'Non è stato possibile caricare il prodotto.' }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ productId: string }> },
) {
  if (!sameOrigin(request))
    return Response.json({ error: 'Richiesta non valida.' }, { status: 403 });
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user)
    return Response.json({ error: 'Accedi per modificare il prodotto.' }, { status: 401 });
  const { productId } = await params;
  const body = await readJsonLimited(request, 16 * 1024);
  if (!body.ok) return limitedJsonError(body);
  const parsed = updateProductRequestSchema.safeParse(body.value);
  if (!parsed.success || Object.keys(parsed.data ?? {}).length === 0) {
    return Response.json({ error: 'Controlla i dati del prodotto.' }, { status: 400 });
  }
  try {
    const existing = await prisma.product.findFirst({
      where: { id: productId, shop: { userId: session.user.id } },
      select: { id: true },
    });
    if (!existing) return Response.json({ error: 'Prodotto non trovato.' }, { status: 404 });
    const limited = await enforceRateLimit('products.update', `user:${session.user.id}`);
    if (limited) return limited;
    const updated = await prisma.product.updateMany({
      where: { id: productId, shop: { userId: session.user.id } },
      data: parsed.data,
    });
    if (updated.count === 0)
      return Response.json({ error: 'Prodotto non trovato.' }, { status: 404 });
    const product = await readOwnedProduct(productId, session.user.id);
    if (!product) return Response.json({ error: 'Prodotto non trovato.' }, { status: 404 });
    return Response.json(toResponse(product));
  } catch {
    return Response.json(
      { error: 'Non è stato possibile aggiornare il prodotto.' },
      { status: 500 },
    );
  }
}

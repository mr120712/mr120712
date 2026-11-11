// @polsia:user-owned
import 'server-only';

import { auth } from '@/lib/auth';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import {
  createShopRequestSchema,
  productCheckResultSchema,
  shopsResponseSchema,
} from '@/lib/contracts/workspace';
import { prisma } from '@/lib/db';
import { sameOrigin } from '@/lib/same-origin';

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user)
    return Response.json({ error: 'Accedi per visualizzare i negozi.' }, { status: 401 });

  try {
    const rows = await prisma.shop.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        createdAt: true,
        products: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            shopId: true,
            name: true,
            url: true,
            expectedPriceCents: true,
            expectedAvailability: true,
            currency: true,
            createdAt: true,
            updatedAt: true,
            checks: {
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: { id: true, status: true, checkedAt: true, result: true },
            },
          },
        },
      },
    });
    const response = shopsResponseSchema.parse({
      shops: rows.map((shop) => ({
        id: shop.id,
        name: shop.name,
        createdAt: shop.createdAt.toISOString(),
        products: shop.products.map((product) => {
          const latest = product.checks[0];
          return {
            id: product.id,
            shopId: product.shopId,
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
                  checkedAt: latest.checkedAt?.toISOString() ?? null,
                  issueCount: productCheckResultSchema.parse(latest.result).issues.length,
                }
              : null,
          };
        }),
      })),
    });
    return Response.json(response, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ error: 'Non è stato possibile caricare i negozi.' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request))
    return Response.json({ error: 'Richiesta non valida.' }, { status: 403 });
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user)
    return Response.json({ error: 'Accedi per creare un negozio.' }, { status: 401 });

  const body = await readJsonLimited(request, 8192);
  if (!body.ok) return limitedJsonError(body);
  const parsed = createShopRequestSchema.safeParse(body.value);
  if (!parsed.success)
    return Response.json({ error: 'Inserisci un nome negozio valido.' }, { status: 400 });

  const limited = await enforceRateLimit('shops.create', `user:${session.user.id}`);
  if (limited) return limited;

  try {
    const shop = await prisma.shop.create({
      data: { userId: session.user.id, name: parsed.data.name },
      select: { id: true, name: true, createdAt: true },
    });
    return Response.json(
      {
        shop: {
          id: shop.id,
          name: shop.name,
          createdAt: shop.createdAt.toISOString(),
          products: [],
        },
      },
      { status: 201 },
    );
  } catch {
    return Response.json({ error: 'Non è stato possibile creare il negozio.' }, { status: 500 });
  }
}

// @polsia:user-owned
import 'server-only';

import { auth } from '@/lib/auth';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import { createProductRequestSchema, productResponseSchema } from '@/lib/contracts/workspace';
import { prisma } from '@/lib/db';
import { sameOrigin } from '@/lib/same-origin';

export async function POST(request: Request, { params }: { params: Promise<{ shopId: string }> }) {
  if (!sameOrigin(request))
    return Response.json({ error: 'Richiesta non valida.' }, { status: 403 });
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user)
    return Response.json({ error: 'Accedi per aggiungere un prodotto.' }, { status: 401 });
  const { shopId } = await params;
  const body = await readJsonLimited(request, 16 * 1024);
  if (!body.ok) return limitedJsonError(body);
  const parsed = createProductRequestSchema.safeParse(body.value);
  if (!parsed.success)
    return Response.json(
      { error: 'Controlla nome, URL, prezzo e disponibilità.' },
      { status: 400 },
    );

  try {
    const shop = await prisma.shop.findFirst({
      where: { id: shopId, userId: session.user.id },
      select: { id: true },
    });
    if (!shop) return Response.json({ error: 'Negozio non trovato.' }, { status: 404 });
    const limited = await enforceRateLimit('products.create', `user:${session.user.id}`);
    if (limited) return limited;
    const product = await prisma.product.create({
      data: {
        shopId: shop.id,
        name: parsed.data.name,
        url: parsed.data.url,
        expectedPriceCents: parsed.data.expectedPriceCents,
        expectedAvailability: parsed.data.expectedAvailability,
        currency: 'EUR',
      },
      select: {
        id: true,
        shopId: true,
        name: true,
        url: true,
        expectedPriceCents: true,
        expectedAvailability: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    const response = productResponseSchema.parse({
      product: {
        ...product,
        createdAt: product.createdAt.toISOString(),
        updatedAt: product.updatedAt.toISOString(),
        currency: 'EUR',
      },
    });
    return Response.json(response, { status: 201 });
  } catch {
    return Response.json(
      { error: 'Non è stato possibile aggiungere il prodotto.' },
      { status: 500 },
    );
  }
}

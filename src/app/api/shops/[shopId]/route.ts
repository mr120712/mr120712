// @polsia:user-owned
import 'server-only';

import { auth } from '@/lib/auth';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import { updateShopRequestSchema } from '@/lib/contracts/workspace';
import { prisma } from '@/lib/db';
import { sameOrigin } from '@/lib/same-origin';

export async function PATCH(request: Request, { params }: { params: Promise<{ shopId: string }> }) {
  if (!sameOrigin(request))
    return Response.json({ error: 'Richiesta non valida.' }, { status: 403 });
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user)
    return Response.json({ error: 'Accedi per modificare il negozio.' }, { status: 401 });
  const { shopId } = await params;
  const body = await readJsonLimited(request, 8192);
  if (!body.ok) return limitedJsonError(body);
  const parsed = updateShopRequestSchema.safeParse(body.value);
  if (!parsed.success)
    return Response.json({ error: 'Inserisci un nome negozio valido.' }, { status: 400 });

  try {
    const existing = await prisma.shop.findFirst({
      where: { id: shopId, userId: session.user.id },
      select: { id: true },
    });
    if (!existing) return Response.json({ error: 'Negozio non trovato.' }, { status: 404 });
    const limited = await enforceRateLimit('shops.update', `user:${session.user.id}`);
    if (limited) return limited;
    const updated = await prisma.shop.updateMany({
      where: { id: shopId, userId: session.user.id },
      data: { name: parsed.data.name },
    });
    if (updated.count === 0)
      return Response.json({ error: 'Negozio non trovato.' }, { status: 404 });
    const shop = await prisma.shop.findFirst({
      where: { id: shopId, userId: session.user.id },
      select: { id: true, name: true, createdAt: true },
    });
    if (!shop) return Response.json({ error: 'Negozio non trovato.' }, { status: 404 });
    return Response.json({
      shop: { ...shop, createdAt: shop.createdAt.toISOString(), products: [] },
    });
  } catch {
    return Response.json(
      { error: 'Non è stato possibile aggiornare il negozio.' },
      { status: 500 },
    );
  }
}

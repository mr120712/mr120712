// @polsia:user-owned

import 'server-only';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { type CorrectionRow, correctionRows } from '@/lib/business/correction-rows';
import { productCheckResultSchema } from '@/lib/contracts/workspace';
import { prisma } from '@/lib/db';
import {
  CsvAccessError,
  CsvExportError,
  type CsvServerSource,
  defineCsvSource,
  type ExportContext,
} from '@/modules/csv-export/server';

const correctionFiltersSchema = z
  .object({
    shopId: z.string().min(1).max(128),
    productId: z.string().min(1).max(128).optional(),
  })
  .strict();

type CorrectionFilters = z.infer<typeof correctionFiltersSchema>;

const correctionSource = defineCsvSource<CorrectionRow, CorrectionFilters>({
  id: 'product-corrections',
  label: 'Correzioni dei prodotti',
  schemaVersion: '1',
  columns: [
    {
      key: 'product_name',
      label: 'Prodotto',
      kind: 'text',
      access: 'readonly',
      nullable: false,
      serialize: (row) => row.productName,
    },
    {
      key: 'product_url',
      label: 'URL prodotto',
      kind: 'text',
      access: 'readonly',
      nullable: false,
      serialize: (row) => row.productUrl,
    },
    {
      key: 'field',
      label: 'Campo',
      kind: 'text',
      access: 'readonly',
      nullable: false,
      serialize: (row) => row.field,
    },
    {
      key: 'expected',
      label: 'Valore atteso',
      kind: 'text',
      access: 'readonly',
      nullable: false,
      serialize: (row) => row.expected,
    },
    {
      key: 'observed',
      label: 'Valore rilevato',
      kind: 'text',
      access: 'readonly',
      nullable: true,
      serialize: (row) => row.observed,
    },
    {
      key: 'reason',
      label: 'Motivo',
      kind: 'text',
      access: 'readonly',
      nullable: false,
      serialize: (row) => row.reason,
    },
    {
      key: 'action',
      label: 'Intervento da rivedere',
      kind: 'text',
      access: 'readonly',
      nullable: false,
      serialize: (row) => row.action,
    },
    {
      key: 'checked_at',
      label: 'Data controllo',
      kind: 'datetime',
      access: 'readonly',
      nullable: false,
      serialize: (row) => row.checkedAt,
    },
  ],
  parseFilters(raw) {
    const parsed = correctionFiltersSchema.safeParse(raw);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
  },
  async authorizeColumns() {
    return [
      'product_name',
      'product_url',
      'field',
      'expected',
      'observed',
      'reason',
      'action',
      'checked_at',
    ];
  },
  keyOf: (row) => row.id,
  versionOf: (row) => row.checkedAt,
  async readRows({ context, filters, limit, signal }) {
    if (signal.aborted) throw new CsvExportError('CANCELLED');
    return prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout = '25000ms'`;
        const shop = await tx.shop.findFirst({
          where: { id: filters.shopId, userId: context.actorId },
          select: { id: true },
        });
        if (!shop) throw new CsvAccessError(403);

        if (filters.productId) {
          const ownedProduct = await tx.product.findFirst({
            where: { id: filters.productId, shopId: shop.id },
            select: { id: true },
          });
          if (!ownedProduct) throw new CsvAccessError(403);
        }

        const products = await tx.product.findMany({
          where: {
            shopId: shop.id,
            ...(filters.productId ? { id: filters.productId } : {}),
          },
          orderBy: { id: 'asc' },
          take: filters.productId ? 1 : limit,
          select: {
            id: true,
            name: true,
            url: true,
            checks: {
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: { checkedAt: true, result: true },
            },
          },
        });
        if (!filters.productId && products.length === limit) throw new CsvExportError('ROW_LIMIT');

        const rows: CorrectionRow[] = [];
        for (const product of products) {
          if (signal.aborted) throw new CsvExportError('CANCELLED');
          const latest = product.checks[0];
          if (!latest?.checkedAt) continue;
          const result = productCheckResultSchema.parse(latest.result);
          rows.push(
            ...correctionRows({
              productId: product.id,
              productName: product.name,
              productUrl: product.url,
              checkedAt: latest.checkedAt.toISOString(),
              result,
            }),
          );
          if (rows.length > limit) return rows.slice(0, limit + 1);
        }
        return rows;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 28_000 },
    );
  },
});

export const csvExportSources: CsvServerSource[] = [correctionSource];

export async function authorizeCorrectionScope(request: Request): Promise<Response | null> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return null;

  const length = request.headers.get('content-length');
  if (length !== null && Number(length) > 65_536) return null;
  const reader = request.clone().body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  let body: unknown;
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (
    !body ||
    typeof body !== 'object' ||
    !('sourceId' in body) ||
    body.sourceId !== 'product-corrections' ||
    !('filters' in body)
  )
    return null;
  const filters = correctionFiltersSchema.safeParse(body.filters);
  if (!filters.success) return null;

  const shop = await prisma.shop.findFirst({
    where: { id: filters.data.shopId, userId: session.user.id },
    select: { id: true },
  });
  if (!shop)
    return Response.json(
      { ok: false, error: { code: 'FORBIDDEN', message: 'Non puoi esportare questo negozio.' } },
      { status: 403 },
    );
  if (filters.data.productId) {
    const product = await prisma.product.findFirst({
      where: { id: filters.data.productId, shopId: shop.id },
      select: { id: true },
    });
    if (!product)
      return Response.json(
        { ok: false, error: { code: 'FORBIDDEN', message: 'Non puoi esportare questo prodotto.' } },
        { status: 403 },
      );
  }
  return null;
}

export async function authorizeCsvExport(
  request: Request,
  _sourceId: string,
): Promise<ExportContext> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) throw new CsvAccessError(401);
  return { actorId: session.user.id, scopeId: session.user.id };
}

// @polsia:user-owned

import { z } from 'zod';

const idSchema = z.string().min(1).max(128);
const isoDateSchema = z.string().datetime();
const webUrlSchema = z
  .string()
  .url()
  .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol));

export const checkIssueSchema = z
  .object({
    id: z.string().min(1),
    field: z.enum(['page', 'link', 'redirect', 'price', 'availability']),
    kind: z.enum(['anomaly', 'unverifiable']),
    expected: z.string(),
    observed: z.string().nullable(),
    reason: z.string().min(1),
    action: z.string().min(1),
    url: webUrlSchema.nullable(),
  })
  .strict();

export const factCheckSchema = z
  .object({
    status: z.enum(['match', 'anomaly', 'unverifiable']),
    expected: z.string(),
    observed: z.string().nullable(),
    evidence: z.string().nullable(),
    reason: z.string().nullable(),
  })
  .strict();

export const linkCheckSchema = z
  .object({
    url: webUrlSchema,
    label: z.string(),
    status: z.enum(['pending', 'readable', 'unverifiable']),
    title: z.string().nullable(),
    reason: z.string().nullable(),
    checkedAt: isoDateSchema.nullable(),
    redirectStatus: z.literal('unverifiable'),
  })
  .strict();

export const productCheckResultSchema = z
  .object({
    expected: z
      .object({
        priceCents: z.number().int().nonnegative(),
        currency: z.literal('EUR'),
        available: z.boolean(),
      })
      .strict(),
    page: z
      .object({
        status: z.enum(['pending', 'readable', 'unverifiable']),
        title: z.string().nullable(),
        sourceUrl: webUrlSchema.nullable(),
        fetchedAt: isoDateSchema.nullable(),
        truncated: z.boolean(),
        reason: z.string().nullable(),
      })
      .strict(),
    price: factCheckSchema,
    availability: factCheckSchema,
    links: z.array(linkCheckSchema),
    issues: z.array(checkIssueSchema),
  })
  .strict();

export const productCheckRecordSchema = z
  .object({
    id: idSchema,
    status: z.enum(['in_progress', 'completed', 'failed']),
    createdAt: isoDateSchema,
    checkedAt: isoDateSchema.nullable(),
    isCurrent: z.boolean(),
    result: productCheckResultSchema,
  })
  .strict();

export const latestCheckSummarySchema = z
  .object({
    id: idSchema,
    status: z.enum(['in_progress', 'completed', 'failed']),
    checkedAt: isoDateSchema.nullable(),
    issueCount: z.number().int().nonnegative(),
  })
  .strict();

export const productSummarySchema = z
  .object({
    id: idSchema,
    shopId: idSchema,
    name: z.string().min(1),
    url: webUrlSchema,
    expectedPriceCents: z.number().int().nonnegative(),
    expectedAvailability: z.boolean(),
    currency: z.literal('EUR'),
    createdAt: isoDateSchema,
    updatedAt: isoDateSchema,
    latestCheck: latestCheckSummarySchema.nullable(),
  })
  .strict();

export const shopSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1),
    createdAt: isoDateSchema,
    products: z.array(productSummarySchema),
  })
  .strict();

export const shopsResponseSchema = z.object({ shops: z.array(shopSchema) }).strict();
export const shopResponseSchema = z.object({ shop: shopSchema }).strict();

export const productDetailSchema = z
  .object({
    id: idSchema,
    shopId: idSchema,
    shopName: z.string().min(1),
    name: z.string().min(1),
    url: webUrlSchema,
    expectedPriceCents: z.number().int().nonnegative(),
    expectedAvailability: z.boolean(),
    currency: z.literal('EUR'),
    createdAt: isoDateSchema,
    updatedAt: isoDateSchema,
    latestCheck: productCheckRecordSchema.nullable(),
  })
  .strict();

export const productDetailResponseSchema = z.object({ product: productDetailSchema }).strict();

export const productResponseSchema = z
  .object({
    product: productSummarySchema.omit({ latestCheck: true }),
  })
  .strict();

export const productCheckResponseSchema = z
  .object({
    check: productCheckRecordSchema,
    remainingLinks: z.number().int().nonnegative(),
  })
  .strict();

export const createShopRequestSchema = z
  .object({ name: z.string().trim().min(2).max(100) })
  .strict();

export const updateShopRequestSchema = createShopRequestSchema;

export const createProductRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    url: webUrlSchema,
    expectedPriceCents: z.number().int().min(0).max(100_000_000),
    expectedAvailability: z.boolean(),
    currency: z.literal('EUR').default('EUR'),
  })
  .strict();

export const updateProductRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    url: webUrlSchema.optional(),
    expectedPriceCents: z.number().int().min(0).max(100_000_000).optional(),
    expectedAvailability: z.boolean().optional(),
  })
  .strict();

export type CheckIssue = z.infer<typeof checkIssueSchema>;
export type FactCheck = z.infer<typeof factCheckSchema>;
export type LinkCheck = z.infer<typeof linkCheckSchema>;
export type ProductCheckResult = z.infer<typeof productCheckResultSchema>;
export type ProductCheckRecord = z.infer<typeof productCheckRecordSchema>;
export type ProductSummary = z.infer<typeof productSummarySchema>;
export type ShopSummary = z.infer<typeof shopSchema>;
export type ProductDetail = z.infer<typeof productDetailSchema>;

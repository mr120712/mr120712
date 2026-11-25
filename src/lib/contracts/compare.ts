// @polsia:user-owned — contratto condiviso per /api/compare. Zod only, nessun
// import server-only.

import { z } from 'zod';

export const CompareRequest = z.object({
  model: z.string().min(1, 'Modello richiesto').max(300, 'Nome modello troppo lungo'),
  prompt: z.string().min(1, 'Prompt vuoto').max(8000, 'Prompt troppo lungo'),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(4096).optional(),
});

export const CompareUsage = z.object({
  promptTokens: z.number().int().nonnegative().optional(),
  completionTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
});

export const CompareResult = z.object({
  model: z.string(),
  status: z.enum(['ok', 'error']),
  content: z.string().nullable().optional(),
  reasoning: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  latencyMs: z.number().int().nonnegative(),
  usage: CompareUsage.nullable().optional(),
  resolvedModel: z.string().nullable().optional(),
  finishReason: z.string().nullable().optional(),
});

export type CompareRequest = z.infer<typeof CompareRequest>;
export type CompareResult = z.infer<typeof CompareResult>;
export type CompareUsage = z.infer<typeof CompareUsage>;

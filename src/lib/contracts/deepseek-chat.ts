// @polsia:user-owned — contratto della chat admin con DeepSeek (server dell'owner, via worker yt-dlp).
import { z } from 'zod';

export const DeepseekChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(8000),
});

export const DeepseekChatRequestSchema = z
  .object({
    messages: z.array(DeepseekChatMessageSchema).min(1).max(40),
    system: z.string().trim().max(4000).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().min(64).max(8192).optional(),
  })
  .superRefine((request, context) => {
    if (request.messages.at(-1)?.role !== 'user') {
      context.addIssue({
        code: 'custom',
        message: 'L’ultimo messaggio deve essere una richiesta.',
      });
    }
    if (request.messages.reduce((sum, message) => sum + message.content.length, 0) > 60_000) {
      context.addIssue({ code: 'custom', message: 'La conversazione è troppo lunga.' });
    }
  });

export const DeepseekChatResponseSchema = z.object({
  reply: z.string().min(1),
  model: z.string(),
});

export type DeepseekChatMessage = z.infer<typeof DeepseekChatMessageSchema>;
export type DeepseekChatRequest = z.infer<typeof DeepseekChatRequestSchema>;
export type DeepseekChatResponse = z.infer<typeof DeepseekChatResponseSchema>;

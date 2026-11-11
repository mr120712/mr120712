// @polsia:user-owned
import { z } from 'zod';

export const AdminAssistantMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(4000),
});

export const AdminAssistantRequestSchema = z
  .object({
    messages: z.array(AdminAssistantMessageSchema).min(1).max(24),
  })
  .superRefine((request, context) => {
    const last = request.messages.at(-1);
    if (last?.role !== 'user') {
      context.addIssue({
        code: 'custom',
        message: 'L’ultimo messaggio deve essere una richiesta.',
      });
    }
    if (request.messages.reduce((sum, message) => sum + message.content.length, 0) > 16000) {
      context.addIssue({ code: 'custom', message: 'La conversazione è troppo lunga.' });
    }
  });

export const AdminAssistantResponseSchema = z.object({
  reply: z.string().min(1),
});

export type AdminAssistantMessage = z.infer<typeof AdminAssistantMessageSchema>;
export type AdminAssistantRequest = z.infer<typeof AdminAssistantRequestSchema>;

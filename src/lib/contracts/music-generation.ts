// @polsia:user-owned
import { z } from 'zod';

export const createSongRequestSchema = z.object({
  prompt: z.string().trim().min(20).max(1200),
});

export type CreateSongRequest = z.infer<typeof createSongRequestSchema>;

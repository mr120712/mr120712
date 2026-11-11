// @polsia:user-owned
import { z } from 'zod';

export const ACCOUNT_DELETION_CONFIRMATION = 'ELIMINA ACCOUNT';

export const AccountDeletionRequestSchema = z
  .object({ confirmation: z.literal(ACCOUNT_DELETION_CONFIRMATION) })
  .strict();

export const AccountDeletionResponseSchema = z.object({ deleted: z.literal(true) }).strict();

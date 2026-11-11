// @polsia:user-owned
import { z } from 'zod';

const catalogId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const privateFileKey = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((value) => !value.includes('://') && !value.split('/').includes('..'));

export const MusicRightsRegistrationSchema = z
  .object({
    albumId: catalogId,
    trackId: catalogId,
    audio: z
      .object({
        key: privateFileKey,
        mimeType: z.string().regex(/^audio\/[a-z0-9][a-z0-9.+-]*$/i),
        byteLength: z
          .number()
          .int()
          .positive()
          .max(500 * 1024 * 1024),
      })
      .strict(),
    evidence: z
      .object({
        key: privateFileKey,
        mimeType: z.enum(['application/pdf', 'image/jpeg', 'image/png']),
        byteLength: z
          .number()
          .int()
          .positive()
          .max(50 * 1024 * 1024),
      })
      .strict(),
    validFrom: z.string().datetime({ offset: true }),
    validUntil: z.string().datetime({ offset: true }),
    confirmFullTrackAndSolcoRights: z.literal(true),
  })
  .strict()
  .refine((value) => Date.parse(value.validUntil) > Date.parse(value.validFrom), {
    message: 'La fine della validità deve essere successiva all’inizio.',
    path: ['validUntil'],
  });

export const MusicRightsActionSchema = z
  .object({ action: z.enum(['deactivate_source', 'revoke_evidence']) })
  .strict();

export const MusicRightsAdminRecordSchema = z.object({
  sourceId: z.string().min(1),
  albumId: catalogId,
  trackId: catalogId,
  active: z.boolean(),
  completeness: z.literal('full_track'),
  durationSeconds: z.number().positive(),
  rightsState: z.enum(['current', 'scheduled', 'expired', 'revoked', 'missing']),
  validFrom: z.string().datetime().nullable(),
  validUntil: z.string().datetime().nullable(),
  verifiedByUserId: z.string().min(1).nullable(),
  verifiedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
});

export const MusicRightsAdminListSchema = z.object({
  records: z.array(MusicRightsAdminRecordSchema),
});

export const MusicRightsMutationSchema = z.object({
  sourceId: z.string().min(1),
  state: z.enum(['recorded', 'deactivated', 'revoked']),
});

export type MusicRightsRegistration = z.infer<typeof MusicRightsRegistrationSchema>;
export type MusicRightsAdminRecord = z.infer<typeof MusicRightsAdminRecordSchema>;

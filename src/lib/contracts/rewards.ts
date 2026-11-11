// @polsia:user-owned — contratti dei premi Solco.
import { z } from 'zod';

export const RewardsSummarySchema = z.object({
  code: z.string().min(1),
  founderNumber: z.number().int().positive().nullable(),
  birthday: z
    .string()
    .regex(/^\d{2}-\d{2}$/)
    .nullable(),
  friends: z.object({ joined: z.number().int(), qualified: z.number().int() }),
  listening: z.object({ qualifyingDays: z.number().int(), nextRewardIn: z.number().int() }),
  loyaltyMonths: z.number().int().nullable(),
  activeGrantUntil: z.string().datetime().nullable(),
  premiumUntil: z.string().datetime().nullable(),
  grants: z.array(
    z.object({
      reason: z.string(),
      days: z.number().int(),
      startsAt: z.string().datetime(),
      endsAt: z.string().datetime(),
    }),
  ),
});
export type RewardsSummary = z.infer<typeof RewardsSummarySchema>;

export const RewardsActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('claim_referral') }),
  z.object({ action: z.literal('listen'), seconds: z.number().int().min(1).max(120) }),
  z.object({ action: z.literal('set_birthday'), birthday: z.string().max(5) }),
]);

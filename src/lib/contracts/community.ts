// @polsia:user-owned
import { z } from 'zod';

export const CommunityProfileRoleSchema = z.enum(['fan', 'artist']);
export const CommunityVisibilitySchema = z.enum(['public', 'private']);

export const CommunityProfileSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: CommunityProfileRoleSchema,
  followerCount: z.number().int().nonnegative().nullable(),
  followingCount: z.number().int().nonnegative().nullable(),
  followersVisible: z.boolean(),
  followingVisible: z.boolean(),
  isFollowing: z.boolean(),
});

export const CommunityDirectoryResponseSchema = z.object({
  profiles: z.array(CommunityProfileSummarySchema),
  nextOffset: z.number().int().nonnegative().nullable(),
});

export const CommunityProfileResponseSchema = z.object({
  profile: CommunityProfileSummarySchema.extend({
    isSelf: z.boolean(),
  }),
});

export const CommunityConnectionsResponseSchema = z.object({
  profiles: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      role: CommunityProfileRoleSchema,
      isFollowing: z.boolean(),
    }),
  ),
  nextOffset: z.number().int().nonnegative().nullable(),
});

export const CommunitySettingsSchema = z.object({
  profileRole: CommunityProfileRoleSchema,
  profileVisibility: CommunityVisibilitySchema,
  followersVisibility: CommunityVisibilitySchema,
  followingVisibility: CommunityVisibilitySchema,
});

export const CommunitySelfResponseSchema = z.object({
  profile: CommunitySettingsSchema.extend({
    id: z.string().min(1),
    name: z.string().min(1),
    followerCount: z.number().int().nonnegative(),
    followingCount: z.number().int().nonnegative(),
  }),
});

export const CommunityFollowRequestSchema = z.object({
  profileId: z.string().min(1).max(64),
});

export const CommunityFollowResponseSchema = z.object({
  following: z.boolean(),
});

export type CommunityProfileRole = z.infer<typeof CommunityProfileRoleSchema>;
export type CommunityProfileSummary = z.infer<typeof CommunityProfileSummarySchema>;
export type CommunitySettings = z.infer<typeof CommunitySettingsSchema>;

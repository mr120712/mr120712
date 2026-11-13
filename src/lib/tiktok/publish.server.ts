// @polsia:user-owned — Content Posting API di TikTok (Direct Post con PULL_FROM_URL). Prima si
// interroga creator_info (opzioni di privacy, limiti), poi si avvia la pubblicazione e se ne segue
// lo stato. Il video è un URL https pubblico di un dominio verificato nel portale TikTok.
import 'server-only';
import { z } from 'zod';
import { TIKTOK_PRIVACY_LEVELS, type TikTokPrivacyLevel } from '@/lib/contracts/tiktok-connect';
import { postApi, TikTokError } from '@/lib/tiktok/client.server';
import { TIKTOK_API_BASE } from '@/lib/tiktok/config.server';

/** Lunghezza massima della didascalia (title) accettata da TikTok. */
export const TIKTOK_TITLE_MAX = 2_200;

export type TikTokCreatorInfo = {
  nickname: string;
  privacyLevelOptions: TikTokPrivacyLevel[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoDurationSec: number;
};

const CreatorInfoSchema = z.object({
  creator_nickname: z.string().max(200).optional().default(''),
  privacy_level_options: z.array(z.string()).optional().default([]),
  comment_disabled: z.boolean().optional().default(false),
  duet_disabled: z.boolean().optional().default(false),
  stitch_disabled: z.boolean().optional().default(false),
  max_video_post_duration_sec: z.number().int().nonnegative().optional().default(0),
});

const PRIVACY_SET = new Set<string>(TIKTOK_PRIVACY_LEVELS);

/** Interroga le informazioni del creator: obbligatorio PRIMA di un Direct Post. */
export async function queryCreatorInfo(
  accessToken: string,
  deadline?: number,
): Promise<TikTokCreatorInfo> {
  const data = await postApi(
    `${TIKTOK_API_BASE}/post/publish/creator_info/query/`,
    accessToken,
    {},
    deadline,
  );
  const parsed = CreatorInfoSchema.safeParse(data);
  if (!parsed.success) throw new TikTokError({ status: 502, reason: 'invalid_response' });
  return {
    nickname: parsed.data.creator_nickname,
    privacyLevelOptions: parsed.data.privacy_level_options.filter(
      (option): option is TikTokPrivacyLevel => PRIVACY_SET.has(option),
    ),
    commentDisabled: parsed.data.comment_disabled,
    duetDisabled: parsed.data.duet_disabled,
    stitchDisabled: parsed.data.stitch_disabled,
    maxVideoDurationSec: parsed.data.max_video_post_duration_sec,
  };
}

export type DirectPostInput = {
  title: string;
  privacyLevel: TikTokPrivacyLevel;
  videoUrl: string;
  disableComment?: boolean;
  disableDuet?: boolean;
  disableStitch?: boolean;
};

/** Corpo della init del Direct Post (funzione pura, testabile). Accorcia il title al limite TikTok. */
export function buildDirectPostBody(input: DirectPostInput): Record<string, unknown> {
  return {
    post_info: {
      title: input.title.slice(0, TIKTOK_TITLE_MAX),
      privacy_level: input.privacyLevel,
      disable_comment: input.disableComment ?? false,
      disable_duet: input.disableDuet ?? false,
      disable_stitch: input.disableStitch ?? false,
    },
    source_info: {
      source: 'PULL_FROM_URL',
      video_url: input.videoUrl,
    },
  };
}

const InitResponseSchema = z.object({ publish_id: z.string().min(1).max(256) });

/** Avvia il Direct Post; ritorna il publish_id da seguire con fetchPublishStatus. */
export async function initDirectPost(
  accessToken: string,
  input: DirectPostInput,
  deadline?: number,
): Promise<string> {
  const data = await postApi(
    `${TIKTOK_API_BASE}/post/publish/video/init/`,
    accessToken,
    buildDirectPostBody(input),
    deadline,
  );
  const parsed = InitResponseSchema.safeParse(data);
  if (!parsed.success) throw new TikTokError({ status: 502, reason: 'invalid_response' });
  return parsed.data.publish_id;
}

export type PublishStatus = {
  status: string;
  failReason: string | null;
  postId: string | null;
};

const StatusResponseSchema = z.object({
  status: z.string().max(100),
  fail_reason: z.string().max(200).optional(),
  publicaly_available_post_id: z.array(z.string()).optional(),
});

/** Segue lo stato del Direct Post. "PUBLISH_COMPLETE" = pubblicato. */
export async function fetchPublishStatus(
  accessToken: string,
  publishId: string,
  deadline?: number,
): Promise<PublishStatus> {
  const data = await postApi(
    `${TIKTOK_API_BASE}/post/publish/status/fetch/`,
    accessToken,
    { publish_id: publishId },
    deadline,
  );
  const parsed = StatusResponseSchema.safeParse(data);
  if (!parsed.success) throw new TikTokError({ status: 502, reason: 'invalid_response' });
  return {
    status: parsed.data.status,
    failReason: parsed.data.fail_reason ?? null,
    postId: parsed.data.publicaly_available_post_id?.[0] ?? null,
  };
}

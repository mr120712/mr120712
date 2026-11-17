// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import { deleteAccountData } from '@/lib/business/account-deletion';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import {
  AccountDeletionRequestSchema,
  AccountDeletionResponseSchema,
} from '@/lib/contracts/account-deletion';
import { prisma } from '@/lib/db';
import { deletePublicUploadBlobs } from '@/lib/music/public-uploads.server';
import { requireAuth, type SessionUser } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

// The only accepted body is the short confirmation phrase.
const MAX_BODY_BYTES = 1024;

export async function DELETE(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: 'forbidden_origin' }, { status: 403 });
  }

  let user: SessionUser;
  try {
    user = await requireAuth(request);
  } catch (response) {
    return response as Response;
  }

  const payload = await readJsonLimited(request, MAX_BODY_BYTES);
  if (!payload.ok && payload.status === 413) return limitedJsonError(payload);
  if (!payload.ok || !AccountDeletionRequestSchema.safeParse(payload.value).success) {
    return NextResponse.json({ error: 'confirmation_required' }, { status: 400 });
  }

  let publicUploadBlobUrls: string[];
  try {
    ({ publicUploadBlobUrls } = await prisma.$transaction((transaction) =>
      deleteAccountData(transaction, user.id, user.email),
    ));
  } catch {
    return NextResponse.json({ error: 'account_deletion_failed' }, { status: 500 });
  }
  // Solo dopo il commit: i file dei brani pubblicati spariscono anche dalla CDN pubblica.
  await deletePublicUploadBlobs(publicUploadBlobUrls);
  return NextResponse.json(AccountDeletionResponseSchema.parse({ deleted: true }));
}

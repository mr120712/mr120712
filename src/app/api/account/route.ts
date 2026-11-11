// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import { deleteAccountData } from '@/lib/business/account-deletion';
import {
  AccountDeletionRequestSchema,
  AccountDeletionResponseSchema,
} from '@/lib/contracts/account-deletion';
import { prisma } from '@/lib/db';
import { requireAuth, type SessionUser } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

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

  const payload = await request.json().catch(() => null);
  if (!AccountDeletionRequestSchema.safeParse(payload).success) {
    return NextResponse.json({ error: 'confirmation_required' }, { status: 400 });
  }

  try {
    await prisma.$transaction((transaction) => deleteAccountData(transaction, user.id, user.email));
    return NextResponse.json(AccountDeletionResponseSchema.parse({ deleted: true }));
  } catch {
    return NextResponse.json({ error: 'account_deletion_failed' }, { status: 500 });
  }
}

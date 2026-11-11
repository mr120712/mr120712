// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const privateHeaders = {
  'Cache-Control': 'private, no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
};

export async function GET(_request: Request) {
  return NextResponse.json(
    { error: 'album_context_required' },
    { status: 403, headers: privateHeaders },
  );
}

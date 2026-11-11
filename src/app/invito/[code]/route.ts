// @polsia:user-owned — link di invito: ricorda il codice e porta alla registrazione.
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const target = new URL('/signup?invito=1', request.url);
  const response = NextResponse.redirect(target, 302);
  if (/^[a-z0-9]{6,12}$/.test(code.toLowerCase())) {
    response.cookies.set('solco_ref', code.toLowerCase(), {
      path: '/',
      maxAge: 30 * 24 * 60 * 60,
      sameSite: 'lax',
      secure: true,
    });
  }
  return response;
}

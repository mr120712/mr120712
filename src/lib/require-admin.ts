// @polsia:framework-owned - DO NOT EDIT. Code installed by polsia/modules/better-auth. Drift = commit rejected.
//
// Legacy server-side redirect helper, retained for compatibility. Admin = a
// better-auth user with role 'admin' (the admin plugin in src/lib/auth.ts).
// Current template pages/layouts MUST NOT import this helper, including Server
// Components: render the client AdminShell once in the /admin layout instead.
// Admin data is loaded by client islands through apiFetch('/api/admin/...').
// Each API handler independently checks the server session/role and returns
// 401/403 on denial (see AGENT.md); never use this redirect helper for an API fetch.
// NEVER hand-roll a separate admin login, a shared password, or a custom admin cookie.

import 'server-only';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';

export async function requireAdmin() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) redirect('/login');
  if (session.user.role !== 'admin') redirect('/');
  return session;
}

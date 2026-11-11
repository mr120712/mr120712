// @polsia:user-owned
'use client';

import { LayoutDashboard } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { signOut, useSession } from '@/lib/auth-client';
import { resolveAdminAccess } from '@/lib/business/admin-account-policy';
import { AdminNav } from './admin-nav';

export interface AdminShellProps {
  children: ReactNode;
}

export function AdminShell({ children }: AdminShellProps) {
  const { data: session, isPending } = useSession();
  const router = useRouter();
  const user = session?.user;
  const access = resolveAdminAccess(isPending, user);
  const _isAdmin = access === 'authorized';

  useEffect(() => {
    if (!isPending && !session?.user) {
      router.replace('/login');
    }
  }, [isPending, router, session?.user]);

  async function handleSignOut() {
    await signOut();
    router.replace('/login');
  }

  if (access === 'loading') {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-gutter">
        <p className="text-sm text-muted-foreground">Caricamento dell’amministrazione…</p>
      </main>
    );
  }

  if (access === 'unauthenticated' || !user) {
    // The effect above redirects to /login; this is the brief transition state,
    // not a stable screen.
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-gutter">
        <p className="text-sm text-muted-foreground">Reindirizzamento all’accesso…</p>
      </main>
    );
  }

  if (access === 'forbidden') {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-gutter">
        <div className="flex w-full max-w-md flex-col gap-4">
          {user.emailVerified ? (
            <>
              <h1 className="text-xl font-semibold">Accesso amministrazione richiesto</h1>
              <p className="text-sm text-muted-foreground">
                Il tuo account non ha i permessi per accedere a quest’area.
              </p>
            </>
          ) : (
            <>
              <h1 className="text-xl font-semibold">Accesso amministrazione richiesto</h1>
              <p className="text-sm text-muted-foreground">
                Serve un account autorizzato con un indirizzo già verificato.
              </p>
            </>
          )}
          <Button asChild variant="outline">
            <Link href="/dashboard">Vai al tuo diario</Link>
          </Button>
          <Button type="button" variant="outline" onClick={handleSignOut}>
            Esci
          </Button>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <div className="flex min-h-dvh flex-col">
        <header className="border-b border-border/70 bg-background">
          <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-4 px-gutter">
            <Link href="/admin" className="flex min-w-0 items-center gap-2">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-card">
                <LayoutDashboard aria-hidden="true" className="size-4" />
              </span>
              <span className="hidden truncate text-sm font-semibold text-foreground sm:inline">
                Amministrazione
              </span>
              <span className="truncate text-sm font-semibold text-foreground sm:hidden">
                Admin
              </span>
            </Link>
            <div className="flex items-center gap-2">
              <Button asChild variant="outline" size="sm">
                <Link href="/">Vai al sito</Link>
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={handleSignOut}>
                Esci
              </Button>
            </div>
          </div>
        </header>

        <div className="mx-auto grid w-full max-w-7xl flex-1 gap-6 px-gutter py-6 lg:grid-cols-[220px_minmax(0,1fr)]">
          <aside className="lg:border-r lg:border-border/70 lg:pr-6">
            <AdminNav />
          </aside>

          <section className="min-w-0">
            <div className="mb-6 flex flex-col gap-1">
              <p className="text-sm text-muted-foreground">Accesso effettuato come</p>
              <p className="truncate text-sm font-medium text-foreground">
                {user.email ?? user.name ?? 'Account'}
              </p>
              <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">
                Accesso amministrazione
              </p>
            </div>
            <Separator className="mb-6" />
            {children}
          </section>
        </div>
      </div>
    </main>
  );
}

// @polsia:user-owned
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { EmailVerification } from '@/components/custom/email-verification';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useSession } from '@/lib/auth-client';
import { accountLabel, needsEmailVerification } from '@/lib/business/phone-auth';
import { SIGN_OUT_FAILED_MESSAGE, signOutAndStopMusic } from '@/lib/music/player-session';
import { DashboardNav } from './dashboard-nav';

export interface DashboardShellProps {
  children: ReactNode;
}

function hasRole(role: string | null | undefined, expected: string) {
  return (
    role
      ?.split(',')
      .map((item) => item.trim())
      .includes(expected) ?? false
  );
}

export function DashboardShell({ children }: DashboardShellProps) {
  const { data: session, isPending } = useSession();
  const router = useRouter();
  const isAdmin = session?.user?.emailVerified === true && hasRole(session.user.role, 'admin');

  useEffect(() => {
    if (!isPending && !session?.user) {
      router.replace('/login');
    }
  }, [isPending, router, session?.user]);

  async function handleSignOut() {
    if (!(await signOutAndStopMusic('/login'))) toast.error(SIGN_OUT_FAILED_MESSAGE);
  }

  if (isPending) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-gutter">
        <p className="text-sm text-muted-foreground">Caricamento del tuo spazio…</p>
      </main>
    );
  }

  if (!session?.user) {
    // The effect above redirects to /login; this is the brief transition state,
    // not a stable screen.
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-gutter">
        <p className="text-sm text-muted-foreground">Reindirizzamento all’accesso…</p>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <div className="flex min-h-dvh flex-col">
        <header className="border-b border-border/70 bg-background">
          <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-4 px-gutter">
            <Link href="/dashboard" className="flex min-w-0 items-center gap-2">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-card font-display text-2xl text-primary">
                s
              </span>
              <span className="truncate text-sm font-semibold text-foreground">Solco</span>
            </Link>
            <div className="flex items-center gap-2">
              {isAdmin && (
                <Button asChild variant="outline" size="sm">
                  <Link href="/admin">Amministrazione</Link>
                </Button>
              )}
              <Button type="button" variant="outline" size="sm" onClick={handleSignOut}>
                Esci
              </Button>
            </div>
          </div>
        </header>

        <div className="mx-auto grid w-full max-w-7xl flex-1 gap-6 px-gutter py-6 lg:grid-cols-[220px_minmax(0,1fr)]">
          <aside className="lg:border-r lg:border-border/70 lg:pr-6">
            <DashboardNav />
          </aside>

          <section className="min-w-0">
            <div className="mb-6 flex flex-col gap-1">
              <p className="text-sm text-muted-foreground">Accesso effettuato come</p>
              <p className="truncate text-sm font-medium text-foreground">
                {accountLabel(session.user)}
              </p>
              <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">
                {isAdmin ? 'Amministrazione' : 'Raccolte personali'}
              </p>
            </div>
            <Separator className="mb-6" />
            {needsEmailVerification(session.user) ? (
              <div className="mb-6 rounded-xl border border-border bg-card p-4">
                <p className="mb-3 text-sm text-muted-foreground">
                  Verifica il tuo indirizzo email per confermare l’account e attivare l’accesso
                  amministrativo se sei il proprietario autorizzato.
                </p>
                <EmailVerification email={session.user.email} callbackURL="/dashboard" />
              </div>
            ) : null}
            {children}
          </section>
        </div>
      </div>
    </main>
  );
}

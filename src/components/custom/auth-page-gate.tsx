// @polsia:user-owned
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useSession } from '@/lib/auth-client';
import { safeAuthDestination } from '@/lib/business/auth-form';

const DEFAULT_DESTINATION = '/dashboard';

/** Where this sign-in was headed (e.g. back to a shared playlist), as the forms read it. */
function callbackDestination() {
  return safeAuthDestination(new URLSearchParams(window.location.search).get('callbackURL'));
}

export function AuthPageGate({ children }: { children: ReactNode }) {
  const { data: session, isPending } = useSession();
  const router = useRouter();
  const [destination, setDestination] = useState(DEFAULT_DESTINATION);

  useEffect(() => {
    setDestination(callbackDestination());
  }, []);

  // Right after a sign-in the session appears while the form is still navigating to its
  // callbackURL: go to the same place, never override it with /dashboard.
  useEffect(() => {
    if (!isPending && session?.user) router.replace(callbackDestination());
  }, [isPending, router, session?.user]);

  if (isPending) {
    return (
      <main className="flex min-h-dvh items-center justify-center px-gutter">
        <p className="text-sm text-muted-foreground">Verifica dell’accesso…</p>
      </main>
    );
  }

  if (session?.user) {
    const toDashboard = destination === DEFAULT_DESTINATION;
    return (
      <main className="flex min-h-dvh items-center justify-center px-gutter py-section">
        <div className="grid w-full max-w-md justify-items-start gap-4">
          <p className="text-sm font-semibold text-primary">Sei già dentro Solco.</p>
          <h1 className="font-display text-4xl">
            {toDashboard ? 'Il tuo diario ti aspetta.' : 'Ti riportiamo dove eri.'}
          </h1>
          <Button asChild>
            <Link href={destination}>{toDashboard ? 'Apri il diario' : 'Continua'}</Link>
          </Button>
        </div>
      </main>
    );
  }

  return children;
}

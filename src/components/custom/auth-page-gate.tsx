// @polsia:user-owned
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { useSession } from '@/lib/auth-client';

export function AuthPageGate({ children }: { children: ReactNode }) {
  const { data: session, isPending } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (!isPending && session?.user) router.replace('/dashboard');
  }, [isPending, router, session?.user]);

  if (isPending) {
    return (
      <main className="flex min-h-dvh items-center justify-center px-gutter">
        <p className="text-sm text-muted-foreground">Verifica dell’accesso…</p>
      </main>
    );
  }

  if (session?.user) {
    return (
      <main className="flex min-h-dvh items-center justify-center px-gutter py-section">
        <div className="grid w-full max-w-md justify-items-start gap-4">
          <p className="text-sm font-semibold text-primary">Sei già dentro Solco.</p>
          <h1 className="font-display text-4xl">Il tuo diario ti aspetta.</h1>
          <Button asChild>
            <Link href="/dashboard">Apri il diario</Link>
          </Button>
        </div>
      </main>
    );
  }

  return children;
}

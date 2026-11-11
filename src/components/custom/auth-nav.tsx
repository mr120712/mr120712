// @polsia:user-owned — seeded by polsia/modules/better-auth; restyle freely.
'use client';

import { UserRound } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { signOut, useSession } from '@/lib/auth-client';

export function AuthNav({ className }: { className?: string }) {
  const { data: session, isPending } = useSession();
  const pathname = usePathname();

  // Render nothing until the session resolves — avoids a Sign-in→Profile flash.
  if (isPending) return null;

  if (!session?.user) {
    return (
      <nav className={className ?? 'flex items-center gap-2'} aria-label="Account">
        {pathname !== '/login' && (
          <Button asChild variant="ghost" size="sm">
            <Link className="authLogin" href="/login">
              Accedi
            </Link>
          </Button>
        )}
        {pathname !== '/signup' && (
          <Button asChild size="sm" className="hidden sm:inline-flex">
            <Link className="authSignup" href="/signup">
              Registrati
            </Link>
          </Button>
        )}
      </nav>
    );
  }

  return (
    <nav className={className ?? 'flex items-center gap-2'} aria-label="Account">
      <Button asChild variant="ghost" size="icon" aria-label="Profilo">
        <Link className="authProfile" href="/profile">
          <UserRound aria-hidden="true" />
        </Link>
      </Button>
      <Button
        className="authSignOut"
        variant="outline"
        size="sm"
        type="button"
        onClick={async () => {
          await signOut();
          window.location.assign('/');
        }}
      >
        Esci
      </Button>
    </nav>
  );
}

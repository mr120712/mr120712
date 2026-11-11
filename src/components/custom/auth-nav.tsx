// @polsia:user-owned — seeded by polsia/modules/better-auth; restyle freely.
'use client';

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
            <Link className="authLogin" data-auth-variant="desktop" href="/login">
              Accedi
            </Link>
          </Button>
        )}
        {pathname !== '/signup' && (
          <Button asChild size="sm">
            <Link className="authSignup" data-auth-variant="desktop" href="/signup">
              Registrati
            </Link>
          </Button>
        )}
        {pathname !== '/login' && (
          <Button asChild size="sm">
            <Link className="authMobileEntry" data-auth-variant="mobile" href="/login">
              Accedi
            </Link>
          </Button>
        )}
      </nav>
    );
  }

  return (
    <nav className={className ?? 'flex items-center gap-2'} aria-label="Account">
      <Button asChild variant="ghost">
        <Link className="authMessages" href="/messages">
          Messaggi
        </Link>
      </Button>
      <Button asChild variant="ghost">
        <Link className="authWorkspace" href="/dashboard">
          Le mie raccolte
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

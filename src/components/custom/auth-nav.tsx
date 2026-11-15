// @polsia:user-owned — seeded by polsia/modules/better-auth; restyle freely. Per un account Premium
// la stellina «Premium» sull'icona del profilo (stato dal player: GET /api/music/access).
'use client';

import { UserRound } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { toast } from 'sonner';
import { useOptionalMusicPlayer } from '@/components/custom/music/music-player';
import { PremiumStarDot } from '@/components/custom/premium-badge';
import { Button } from '@/components/ui/button';
import { useSession } from '@/lib/auth-client';
import { SIGN_OUT_FAILED_MESSAGE, signOutAndStopMusic } from '@/lib/music/player-session';

export function AuthNav({ className }: { className?: string }) {
  const { data: session, isPending } = useSession();
  const pathname = usePathname();
  // Il player controlla già il Premium (e lo ricontrolla quando cambia l'account): nessuna richiesta
  // in più. Fuori dal player (componente reso da solo) niente stellina.
  const premium = useOptionalMusicPlayer()?.premium === true;

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
      <Button
        asChild
        variant="ghost"
        size="icon"
        className="relative"
        aria-label={premium ? 'Profilo, account Premium' : 'Profilo'}
        title={premium ? 'Profilo · Premium' : undefined}
      >
        <Link className="authProfile" href="/profile">
          <UserRound aria-hidden="true" />
          {premium ? <PremiumStarDot /> : null}
        </Link>
      </Button>
      <Button
        className="authSignOut"
        variant="outline"
        size="sm"
        type="button"
        onClick={async () => {
          if (!(await signOutAndStopMusic('/'))) toast.error(SIGN_OUT_FAILED_MESSAGE);
        }}
      >
        Esci
      </Button>
    </nav>
  );
}

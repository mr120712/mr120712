// @polsia:user-owned — profile view supplied by better-auth.
'use client';

import Link from 'next/link';
import { toast } from 'sonner';
import { AccountDeletionPanel } from '@/components/custom/account-deletion-panel';
import { CommunitySettingsPanel } from '@/components/custom/community/community-settings';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { useSession } from '@/lib/auth-client';
import { accountLabel, isPhoneAccount } from '@/lib/business/phone-auth';
import { SIGN_OUT_FAILED_MESSAGE, signOutAndStopMusic } from '@/lib/music/player-session';

export default function ProfilePage() {
  const { data: session, isPending } = useSession();

  if (isPending) {
    return (
      <main className="flex min-h-dvh items-center justify-center px-gutter">
        <p className="text-sm text-muted-foreground">Caricamento del profilo…</p>
      </main>
    );
  }

  if (!session?.user) {
    return (
      <main className="flex min-h-dvh items-center justify-center px-gutter py-section">
        <Card className="w-full max-w-md border-border bg-card">
          <CardHeader>
            <CardTitle>Accesso richiesto</CardTitle>
            <CardDescription>Accedi per vedere i dati del tuo account.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild className="w-full">
              <Link href="/login">Accedi</Link>
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="min-h-dvh px-gutter py-section">
      <div className="mx-auto grid w-full max-w-lg grid-cols-1 gap-6 min-w-0">
        <header className="flex items-center gap-4">
          <div
            className="grid size-14 place-items-center rounded-full bg-secondary font-display text-2xl text-secondary-foreground"
            aria-hidden="true"
          >
            {session.user.name?.charAt(0).toLocaleUpperCase('it-IT') ?? 'S'}
          </div>
          <div className="min-w-0">
            <h1 className="truncate font-display text-3xl">{session.user.name}</h1>
            <p className="truncate text-sm text-muted-foreground">{accountLabel(session.user)}</p>
          </div>
        </header>
        <Separator />
        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle>Dati dell’account</CardTitle>
            <CardDescription>Informazioni del tuo accesso a Solco.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <span className="text-muted-foreground">Nome</span>
              <span>{session.user.name}</span>
            </div>
            <Separator />
            <div className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <span className="text-muted-foreground">
                {isPhoneAccount(session.user) ? 'Telefono' : 'Email'}
              </span>
              <span className="max-w-full break-all">{accountLabel(session.user)}</span>
            </div>
          </CardContent>
        </Card>
        <CommunitySettingsPanel />
        <AccountDeletionPanel />
        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={async () => {
              if (!(await signOutAndStopMusic('/login'))) toast.error(SIGN_OUT_FAILED_MESSAGE);
            }}
          >
            Esci
          </Button>
        </div>
      </div>
    </main>
  );
}

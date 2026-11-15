// @polsia:user-owned — profile view supplied by better-auth. Per un account Premium: anello e stellina
// sull'avatar, badge «⭐ Premium» accanto al nome e la fonte nella riga «Piano» (GET /api/account/premium).
// Con l'email non ancora verificata, sotto l'email il pulsante per farsi rimandare il link.
'use client';

import Link from 'next/link';
import { toast } from 'sonner';
import { AccountDeletionPanel } from '@/components/custom/account-deletion-panel';
import { AccountPlanRow } from '@/components/custom/account-plan-row';
import { AccountUidRow } from '@/components/custom/account-uid-row';
import { CommunitySettingsPanel } from '@/components/custom/community/community-settings';
import { EmailVerification } from '@/components/custom/email-verification';
import { PremiumAvatarRing, PremiumBadge } from '@/components/custom/premium-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { useAccountPremium } from '@/hooks/use-account-premium';
import { useSession } from '@/lib/auth-client';
import { accountLabel, isPhoneAccount, needsEmailVerification } from '@/lib/business/phone-auth';
import { SIGN_OUT_FAILED_MESSAGE, signOutAndStopMusic } from '@/lib/music/player-session';

export default function ProfilePage() {
  const { data: session, isPending } = useSession();
  const plan = useAccountPremium(session?.user?.id);
  const premium = plan.status === 'ready' && plan.premium;

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
          <PremiumAvatarRing premium={premium}>
            <div
              className="grid size-14 place-items-center rounded-full bg-secondary font-display text-2xl text-secondary-foreground"
              aria-hidden="true"
            >
              {session.user.name?.charAt(0).toLocaleUpperCase('it-IT') ?? 'S'}
            </div>
          </PremiumAvatarRing>
          <div className="min-w-0">
            {/* Un nome lungo resta intero: il badge va a capo invece di accorciarlo. */}
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="min-w-0 truncate font-display text-3xl">{session.user.name}</h1>
              {premium ? <PremiumBadge /> : null}
            </div>
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
            {/* Email non ancora confermata: il link si può richiedere da qui (non per il telefono). */}
            {needsEmailVerification(session.user) ? (
              <div className="rounded-lg border border-border bg-muted/40 p-4">
                <EmailVerification email={session.user.email} callbackURL="/profile" />
              </div>
            ) : null}
            <Separator />
            {/* Premium (con la fonte) o Free, con il link ai piani. */}
            <AccountPlanRow state={plan} />
            <Separator />
            {/* UID leggibile dell'account (es. SOL-7K2M-9QXD), da dare all'assistenza. */}
            <AccountUidRow />
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

// @polsia:user-owned — sezione «Account» delle Impostazioni (/impostazioni), solo con l'accesso e per
// gli account con email (non quelli creati col telefono): l'email con lo stato «Verificata» o «Non
// verificata» e, se non è verificata, il pulsante per farsi rimandare il link (ritorno qui). Una
// volta confermata l'email, l'amministratore designato diventa admin da solo (hook dell'account).
'use client';

import { UserRound } from 'lucide-react';
import Link from 'next/link';
import { useId } from 'react';
import { StatusBadge } from '@/components/custom/app-ui/status-badge';
import { EmailVerification } from '@/components/custom/email-verification';
import { Button } from '@/components/ui/button';
import { useSession } from '@/lib/auth-client';
import { isPhoneAccount } from '@/lib/business/phone-auth';

export function AccountEmailSettings() {
  const { data: session, isPending } = useSession();
  const headingId = useId();
  const user = session?.user;
  if (isPending || !user?.email || isPhoneAccount(user)) return null;
  const verified = user.emailVerified === true;

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5 text-card-foreground"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id={headingId} className="flex items-center gap-2 text-lg font-semibold">
          <UserRound aria-hidden="true" className="size-5 text-muted-foreground" />
          Account
        </h2>
        <Button asChild variant="link" size="sm" className="h-auto px-0">
          <Link href="/profile">Profilo</Link>
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="text-muted-foreground">Email</span>
        <span className="inline-flex min-w-0 flex-wrap items-center justify-end gap-2">
          <span className="break-all">{user.email}</span>
          {verified ? (
            <StatusBadge tone="positive">Verificata</StatusBadge>
          ) : (
            <StatusBadge tone="warning">Non verificata</StatusBadge>
          )}
        </span>
      </div>
      {verified ? null : (
        <div className="rounded-lg border border-border bg-muted/40 p-4">
          <EmailVerification email={user.email} callbackURL="/impostazioni" headingLevel="h3" />
        </div>
      )}
    </section>
  );
}

// @polsia:user-owned
'use client';

import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiFetch } from '@/lib/api-client';
import { signOut } from '@/lib/auth-client';
import {
  ACCOUNT_DELETION_CONFIRMATION,
  AccountDeletionResponseSchema,
} from '@/lib/contracts/account-deletion';
import { stopPlayerAndForget } from '@/lib/music/player-session';

export function AccountDeletionPanel() {
  const [confirmation, setConfirmation] = useState('');
  const [pending, setPending] = useState(false);

  async function deleteAccount() {
    setPending(true);
    try {
      await apiFetch('/api/account', {
        method: 'DELETE',
        body: JSON.stringify({ confirmation }),
        schema: AccountDeletionResponseSchema,
      });
      // Account eliminato (sessioni comprese): musica ferma e coda dimenticata, poi via.
      stopPlayerAndForget();
      await signOut().catch(() => undefined);
      window.location.assign('/');
    } catch {
      toast.error(
        'Non è stato possibile eliminare l’account. Riprova o scrivi a solcomusic@polsia.app.',
      );
      setPending(false);
    }
  }

  return (
    <section
      aria-labelledby="account-deletion-title"
      className="grid gap-4 rounded-xl border border-destructive/40 p-5"
    >
      <div className="grid gap-2">
        <h2 id="account-deletion-title" className="font-display text-xl">
          Eliminazione account
        </h2>
        <p className="text-sm text-muted-foreground">
          Elimina in modo definitivo l’account Solco, il diario d’ascolto, le relazioni community e
          i dati di prodotti e controlli associati. Le sessioni verranno revocate. L’operazione non
          si può annullare.
        </p>
        <p className="text-sm text-muted-foreground">
          Leggi l’
          <Link className="underline underline-offset-4" href="/privacy">
            informativa privacy
          </Link>{' '}
          per i limiti relativi a copie tecniche o dati che il servizio non controlla.
        </p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="account-deletion-confirmation">
          Per confermare, scrivi <strong>{ACCOUNT_DELETION_CONFIRMATION}</strong>
        </Label>
        <Input
          autoComplete="off"
          id="account-deletion-confirmation"
          onChange={(event) => setConfirmation(event.target.value)}
          value={confirmation}
        />
      </div>
      <div>
        <Button
          className="disabled:border-border disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
          disabled={pending || confirmation !== ACCOUNT_DELETION_CONFIRMATION}
          onClick={deleteAccount}
          type="button"
          variant="destructive"
        >
          {pending ? 'Eliminazione in corso…' : 'Elimina definitivamente l’account'}
        </Button>
      </div>
    </section>
  );
}

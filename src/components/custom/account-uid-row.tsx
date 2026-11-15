// @polsia:user-owned — riga «UID» dei «Dati dell'account» (/profile): l'UID leggibile del proprio
// account (es. SOL-7K2M-9QXD), da comunicare all'assistenza, con il pulsante per copiarlo. Lo legge
// da GET /api/account/uid (che lo assegna se manca). Durante il caricamento un segnaposto della
// stessa altezza; se non arriva, «non disponibile» (il resto della pagina non cambia).
'use client';

import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { AccountUidResponseSchema } from '@/lib/contracts/account-admin';

type UidState = { status: 'loading' } | { status: 'ready'; uid: string } | { status: 'error' };

export function AccountUidRow() {
  const [state, setState] = useState<UidState>({ status: 'loading' });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    apiFetch('/api/account/uid', { schema: AccountUidResponseSchema })
      .then((result) => {
        if (active) setState({ status: 'ready', uid: result.uid });
      })
      .catch(() => {
        if (active) setState({ status: 'error' });
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy(uid: string) {
    try {
      await navigator.clipboard.writeText(uid);
      setCopied(true);
      toast.success('UID copiato.');
    } catch {
      toast.error('Non riesco a copiare: seleziona l’UID e copialo a mano.');
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
      <span className="text-muted-foreground">UID</span>
      {state.status === 'ready' ? (
        <span className="inline-flex items-center gap-1">
          <code className="rounded-md border border-border bg-muted px-2 py-0.5 font-mono text-xs tracking-wide">
            {state.uid}
          </code>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={() => void copy(state.uid)}
            aria-label={copied ? 'UID copiato' : `Copia l’UID ${state.uid}`}
            title="Copia l’UID"
          >
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          </Button>
        </span>
      ) : state.status === 'loading' ? (
        <span className="h-8 w-32 animate-pulse rounded-md bg-muted motion-reduce:animate-none">
          <span className="sr-only">Caricamento dell’UID…</span>
        </span>
      ) : (
        <span className="text-muted-foreground">non disponibile</span>
      )}
    </div>
  );
}

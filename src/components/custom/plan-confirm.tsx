// @polsia:user-owned — conferma dell'abbonamento al ritorno da Stripe Checkout.
'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';

type State = 'checking' | 'active' | 'pending' | 'error';

export function PlanConfirm() {
  const sessionId = useSearchParams().get('session_id') ?? '';
  const [state, setState] = useState<State>('checking');

  useEffect(() => {
    if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
      setState('error');
      return;
    }
    apiFetch<{ active: boolean }>('/api/subscriptions/confirm', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    })
      .then((result) => setState(result.active ? 'active' : 'pending'))
      .catch(() => setState('error'));
  }, [sessionId]);

  return (
    <div>
      {state === 'checking' ? <p>Verifico il pagamento con Stripe…</p> : null}
      {state === 'active' ? (
        <>
          <h1>Benvenuto in Solco Premium!</h1>
          <p>Il tuo abbonamento è attivo. Tutte le funzioni Pro sono sbloccate.</p>
        </>
      ) : null}
      {state === 'pending' ? (
        <>
          <h1>Pagamento in elaborazione</h1>
          <p>
            Stripe sta ancora confermando il pagamento (succede con alcuni metodi, come PayPal o
            bonifico). Ricarica questa pagina tra qualche minuto.
          </p>
        </>
      ) : null}
      {state === 'error' ? (
        <>
          <h1>Non riesco a confermare il pagamento</h1>
          <p>
            Se hai completato il pagamento, accedi con lo stesso account e riapri questa pagina dal
            link di ritorno. Nessun addebito è stato fatto due volte.
          </p>
        </>
      ) : null}
      <Button asChild variant="outline">
        <Link href="/piani">Torna ai piani</Link>
      </Button>
    </div>
  );
}

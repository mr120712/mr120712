// @polsia:user-owned — stato Premium del proprio account per il profilo (GET /api/account/premium):
// Premium con la fonte, oppure Free. Una richiesta per account, ripetuta solo se cambia l'account;
// senza account resta in caricamento (la pagina mostra già l'invito ad accedere).
'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import {
  AccountPremiumResponseSchema,
  type AccountPremiumSource,
} from '@/lib/contracts/account-premium';

export type AccountPremiumState =
  | { status: 'loading' }
  | { status: 'ready'; premium: boolean; source: AccountPremiumSource | null }
  | { status: 'error' };

export function useAccountPremium(userId: string | null | undefined): AccountPremiumState {
  const [state, setState] = useState<AccountPremiumState>({ status: 'loading' });

  useEffect(() => {
    setState({ status: 'loading' });
    if (!userId) return;
    let active = true;
    apiFetch('/api/account/premium', { schema: AccountPremiumResponseSchema })
      .then((body) => {
        if (active) setState({ status: 'ready', premium: body.premium, source: body.source });
      })
      .catch(() => {
        if (active) setState({ status: 'error' });
      });
    return () => {
      active = false;
    };
  }, [userId]);

  return state;
}

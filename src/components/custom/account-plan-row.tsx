// @polsia:user-owned — riga «Piano» dei «Dati dell'account» (/profile): per un account Premium il
// badge «⭐ Premium» con la fonte (Illimitato, Abbonamento, Premio…) e una riga che la spiega; per un
// account Free «Free» e il link ai piani. Lo stato arriva dal profilo (useAccountPremium), che lo usa
// anche per il badge accanto al nome. Caricamento: segnaposto della stessa altezza.
'use client';

import Link from 'next/link';
import { PremiumBadge } from '@/components/custom/premium-badge';
import { Button } from '@/components/ui/button';
import type { AccountPremiumState } from '@/hooks/use-account-premium';
import {
  ACCOUNT_PREMIUM_SOURCE_HINT,
  ACCOUNT_PREMIUM_SOURCE_LABEL,
} from '@/lib/contracts/account-premium';

export function AccountPlanRow({ state }: { state: AccountPremiumState }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
      <span className="text-muted-foreground">Piano</span>
      {state.status === 'ready' ? (
        state.premium && state.source ? (
          <span className="flex flex-col items-end gap-1 text-right">
            <PremiumBadge size="sm" detail={ACCOUNT_PREMIUM_SOURCE_LABEL[state.source]} />
            <span className="text-xs text-muted-foreground">
              {ACCOUNT_PREMIUM_SOURCE_HINT[state.source]}
            </span>
          </span>
        ) : (
          <span className="inline-flex items-center gap-3">
            <span>Free</span>
            <Button asChild variant="link" size="sm" className="h-auto px-0">
              <Link href="/piani">Passa a Premium</Link>
            </Button>
          </span>
        )
      ) : state.status === 'loading' ? (
        <span className="h-7 w-28 animate-pulse rounded-full bg-muted motion-reduce:animate-none">
          <span className="sr-only">Caricamento del piano…</span>
        </span>
      ) : (
        <span className="text-muted-foreground">non disponibile</span>
      )}
    </div>
  );
}

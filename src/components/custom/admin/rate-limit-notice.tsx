// @polsia:user-owned
'use client';

import { ShieldAlert } from 'lucide-react';
import { useSession } from '@/lib/auth-client';
import {
  canViewRateLimitNotice,
  RATE_LIMIT_PROTECTION_NOTICE,
} from '@/lib/business/rate-limit-notice';

export function RateLimitNotice() {
  const { data } = useSession();
  if (!canViewRateLimitNotice(data?.user)) return null;

  return (
    <aside
      className="grid gap-2 rounded-xl border border-status-warning/30 bg-status-warning/5 p-5"
      aria-labelledby="rate-limit-notice-title"
    >
      <div className="flex items-center gap-2 text-status-warning">
        <ShieldAlert aria-hidden="true" className="size-5" />
        <h2 id="rate-limit-notice-title" className="font-semibold text-foreground">
          Limiti e copertura della protezione
        </h2>
      </div>
      <p className="text-sm leading-6 text-muted-foreground">{RATE_LIMIT_PROTECTION_NOTICE}</p>
    </aside>
  );
}

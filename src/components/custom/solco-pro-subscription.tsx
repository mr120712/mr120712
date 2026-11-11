// @polsia:user-owned
'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import {
  type SolcoProEntitlementStatus,
  solcoProEntitlementStatusSchema,
} from '@/lib/contracts/solco-pro';
import { SolcoProPlanOptions } from './solco-pro-plan-options';
import styles from './solco-pro-subscription.module.css';

function stateCopy(status: SolcoProEntitlementStatus) {
  if (status.state === 'active') {
    if (!status.purchase || !status.validUntil) return 'L’accesso Solco Pro è attivo.';
    const date = new Intl.DateTimeFormat('it-IT', { dateStyle: 'long' }).format(
      new Date(status.validUntil),
    );
    const amount = new Intl.NumberFormat('it-IT', {
      style: 'currency',
      currency: status.purchase.currency,
    }).format(status.purchase.amountEuroCents / 100);
    return `Acquisto precedente Solco Pro confermato: ${amount} una tantum per un mese, senza rinnovo. Accesso attivo fino al ${date}.`;
  }
  if (status.state === 'locked') {
    return 'Non risulta un acquisto Solco Pro precedente ancora valido. Lo stato di un abbonamento ricorrente non è verificabile con l’integrazione EUR disponibile.';
  }
  return 'Non è stato possibile verificare l’accesso Solco Pro. Le funzioni restano bloccate.';
}

export function SolcoProSubscription() {
  const [status, setStatus] = useState<SolcoProEntitlementStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiFetch('/api/solco-pro/subscription', {
        schema: solcoProEntitlementStatusSchema,
      });
      setStatus(result);
    } catch {
      setStatus(null);
      setError('Non è stato possibile verificare l’accesso. Le funzioni Pro restano bloccate.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section aria-labelledby="solco-pro-entitlement-title" className={styles.panel}>
      <p className={styles.eyebrow}>SOLCO PRO</p>
      <h2 id="solco-pro-entitlement-title">Abbonamento e pagamenti</h2>
      <div className={styles.currentAccess}>
        <h3>Accesso attuale</h3>
        {loading ? (
          <output className={styles.state}>Verifica dell’accesso…</output>
        ) : status ? (
          <p className={styles.copy}>{stateCopy(status)}</p>
        ) : (
          <p className={styles.copy}>
            {error ?? 'L’accesso non è disponibile. Le funzioni Pro restano bloccate.'}
          </p>
        )}
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
        {!loading && status?.state === 'locked' ? (
          <div className={styles.actions}>
            <Button asChild>
              <Link href="/#piani">Scopri Solco Pro</Link>
            </Button>
          </div>
        ) : null}
        {error ? (
          <div className={styles.actions}>
            <Button type="button" variant="outline" disabled={loading} onClick={() => void load()}>
              Riprova
            </Button>
          </div>
        ) : null}
        <div className={styles.actions}>
          <Button
            type="button"
            variant="outline"
            disabled
            className={styles.portalButton}
            aria-describedby="solco-pro-portal-limit"
          >
            Portale di fatturazione non disponibile
          </Button>
          <p id="solco-pro-portal-limit" className={styles.copy}>
            Il portale Stripe e la gestione di metodo di pagamento, fatture o cancellazioni non sono
            disponibili finché il piano ricorrente EUR e il relativo stato non sono verificabili.
            Gli acquisti una tantum già confermati conservano la propria validità.
          </p>
        </div>
      </div>
      <SolcoProPlanOptions />
    </section>
  );
}

// @polsia:user-owned
'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import styles from '@/app/(setup)/checkout/checkout.module.css';
import { apiFetch } from '@/lib/api-client';
import { getSolcoProCheckoutStatusMessage } from '@/lib/business/solco-pro-billing';
import {
  type SolcoProCheckoutStatus as CheckoutStatus,
  solcoProCheckoutStatusSchema,
  solcoProPurchaseVerificationResponseSchema,
} from '@/lib/contracts/solco-pro';

function formatExpiry(validUntil: string) {
  return new Date(validUntil).toLocaleDateString('it-IT', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

export function SolcoProCheckoutStatus() {
  const [status, setStatus] = useState<CheckoutStatus | null>(null);
  const [verificationError, setVerificationError] = useState(false);

  useEffect(() => {
    let mounted = true;
    const sessionId = new URLSearchParams(window.location.search).get('session_id');
    const request = sessionId
      ? apiFetch('/api/solco-pro/purchase/verify', {
          method: 'POST',
          body: JSON.stringify({ sessionId }),
          schema: solcoProPurchaseVerificationResponseSchema,
        })
      : apiFetch('/api/solco-pro/status', { schema: solcoProCheckoutStatusSchema });

    void request
      .then((result) => {
        if (mounted) setStatus(result);
      })
      .catch(() => {
        if (mounted) setVerificationError(true);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const activeStatus = status?.state === 'active' ? status : null;
  const heading = activeStatus
    ? 'Solco Pro è attivo'
    : verificationError
      ? 'Verifica non disponibile'
      : status?.state === 'unavailable'
        ? 'Acquisto non disponibile'
        : status?.state === 'unconfirmed'
          ? 'Accesso non confermato'
          : 'Verifica in corso';

  return (
    <section className={styles.card} aria-labelledby="checkout-status-title">
      <p className={styles.eyebrow}>VERIFICA SOLCO PRO</p>
      <h1 id="checkout-status-title">{heading}</h1>
      {activeStatus ? (
        <p>
          {getSolcoProCheckoutStatusMessage(activeStatus)} Scade il{' '}
          {formatExpiry(activeStatus.validUntil)}.
        </p>
      ) : verificationError ? (
        <output>
          Non è stato possibile completare la verifica server-side. Nessun accesso Pro viene
          sbloccato; riprova dallo stato del tuo account.
        </output>
      ) : status ? (
        <output>{getSolcoProCheckoutStatusMessage(status)}</output>
      ) : (
        <output>Controllo server-side del pagamento e dell’account in corso.</output>
      )}
      {verificationError ? (
        <Link className={styles.returnLink} href="/login">
          Accedi a Solco
        </Link>
      ) : null}
      <Link className={styles.returnLink} href="/#piani">
        Torna ai prezzi
      </Link>
    </section>
  );
}

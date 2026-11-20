'use client';
// @polsia:user-owned — pannello «Riserva AI · provider» in Amministrazione → Monitoraggio: lo stato di
// ogni provider gratuito del router interno (in stile FreeLLMAPI, ospitato da Solco). Mostra quali sono
// attivi, quali hanno la chiave ma non rispondono, e quali mancano (con la variabile da impostare su
// Vercel e dove prendere una chiave gratuita). Claude resta il motore primario: questa è la riserva.
// Si aggiorna da solo ogni minuto. Solo lettura.

import { AlertTriangle, CheckCircle2, Circle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Panel } from '@/components/custom/app-ui/panel';
import { apiFetch } from '@/lib/api-client';
import {
  type ReserveProvidersOverview,
  ReserveProvidersOverviewSchema,
  type ReserveProviderView,
} from '@/lib/contracts/ai-reserve-providers';
import styles from './ai-reserve-panel.module.css';

const ENDPOINT = '/api/admin/ai-reserve-providers';
const REFRESH_MS = 60_000;

const STATUS_LABEL: Record<ReserveProviderView['status'], string> = {
  live: 'Attivo',
  failing: 'Non risponde',
  not_configured: 'Non configurato',
};

function StatusIcon({ status }: { status: ReserveProviderView['status'] }) {
  if (status === 'live') return <CheckCircle2 aria-hidden="true" className={styles.icon} />;
  if (status === 'failing') return <AlertTriangle aria-hidden="true" className={styles.icon} />;
  return <Circle aria-hidden="true" className={styles.icon} />;
}

function detailText(provider: ReserveProviderView): string {
  if (provider.status === 'live') {
    return `Risponde${provider.httpStatus ? ` (HTTP ${provider.httpStatus})` : ''}`;
  }
  if (provider.status === 'failing') {
    return provider.httpStatus
      ? `Chiave presente, ma l'upstream ha risposto HTTP ${provider.httpStatus}: controlla la chiave o i limiti del free tier`
      : "Chiave presente, ma l'upstream non risponde in questo momento";
  }
  return 'Nessuna chiave nell’ambiente';
}

export function AiReservePanel() {
  const [data, setData] = useState<ReserveProvidersOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await apiFetch(ENDPOINT, { schema: ReserveProvidersOverviewSchema }));
      setError(null);
    } catch {
      setError('Lo stato dei provider della riserva non è disponibile in questo momento.');
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <Panel
      title="Riserva AI · provider gratuiti"
      description="Il router multi-provider ospitato da Solco (in stile FreeLLMAPI): un solo endpoint davanti a più AI gratuite con failover automatico. Claude resta il motore primario; questa è la riserva best-effort. Un provider è attivo solo se la sua chiave è su Vercel — aggiungine una e si accende da solo al prossimo deploy. Il pannello cerca automaticamente gli agent (modelli) che ogni provider serve adesso interrogando /models, così i modelli ritirati si vedono subito."
    >
      {error ? (
        <p role="alert" className={styles.muted}>
          {error}
        </p>
      ) : null}
      {!data && !error ? <p className={styles.muted}>Caricamento…</p> : null}
      {data ? <ReserveBody data={data} /> : null}
    </Panel>
  );
}

function ReserveBody({ data }: { data: ReserveProvidersOverview }) {
  return (
    <div className={styles.body}>
      <output className={styles.summary} data-ok={data.liveCount > 0}>
        <strong>
          {data.liveCount} di {data.total} attivi
        </strong>
        {data.configuredCount > data.liveCount
          ? ` · ${data.configuredCount - data.liveCount} con chiave ma non risponde`
          : ''}
        {data.discoveredTotal > 0 ? ` · ${data.discoveredTotal} agent rilevati` : ''}
      </output>

      <ul className={styles.list}>
        {data.providers.map((provider) => (
          <li key={provider.id} className={styles.row} data-status={provider.status}>
            <StatusIcon status={provider.status} />
            <div className={styles.rowMain}>
              <p className={styles.rowHead}>
                <span className={styles.name}>{provider.label}</span>
                <span className={styles.badge} data-status={provider.status}>
                  {STATUS_LABEL[provider.status]}
                </span>
              </p>
              <p className={styles.muted}>{detailText(provider)}</p>
              {provider.models.length > 0 ? (
                <p className={styles.models}>{provider.models.join(' · ')}</p>
              ) : null}
              {provider.discoveredCount > 0 ? (
                <p className={styles.discovered}>
                  <span className={styles.discoveredLabel}>
                    {provider.discoveredCount} agent rilevati
                  </span>
                  {provider.discoveredModels.length > 0 ? (
                    <span className={styles.discoveredList}>
                      {' · '}
                      {provider.discoveredModels.join(' · ')}
                      {provider.discoveredCount > provider.discoveredModels.length
                        ? ` … +${provider.discoveredCount - provider.discoveredModels.length}`
                        : ''}
                    </span>
                  ) : null}
                </p>
              ) : null}
              {provider.status === 'not_configured' ? (
                <p className={styles.hint}>
                  Imposta <code>{provider.keyVar}</code> su Vercel ·{' '}
                  <a href={provider.signupUrl} target="_blank" rel="noopener noreferrer">
                    ottieni una chiave gratuita →
                  </a>
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      <p className={styles.foot}>
        Dopo aver aggiunto una chiave su Vercel, serve un nuovo deploy perché il router la veda.
        L’ordine del failover si regola con <code>AI_RESERVE_PROVIDERS</code>.
      </p>
    </div>
  );
}

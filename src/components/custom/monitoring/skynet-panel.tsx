'use client';
// @polsia:user-owned — pannello «Skynet» in Amministrazione → Monitoraggio: stato della sentinella
// che guarda il sito ogni minuto (src/lib/skynet/), ultimi segnali, configurazione e diario degli
// avvisi. Si aggiorna da solo ogni minuto. Solo lettura: Skynet avvisa, non cambia nulla.

import { ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Panel } from '@/components/custom/app-ui/panel';
import { apiFetch } from '@/lib/api-client';
import { type SkynetOverview, SkynetOverviewSchema } from '@/lib/contracts/skynet';
import styles from './skynet-panel.module.css';

const ENDPOINT = '/api/admin/skynet';
const REFRESH_MS = 60_000;

const PROBLEM_LABELS: Record<string, string> = {
  ddos: 'possibile attacco DDoS',
  'firewall-off': 'firewall spento',
  'ai-bots-off': 'blocco delle AI spento',
  'skynet-rules': 'regole Skynet mancanti',
  'site-down': 'sito irraggiungibile',
  'site-slow': 'sito lento',
  'internal-down': 'controlli interni in errore',
  'vercel-blind': 'Vercel non leggibile',
};

const KIND_LABELS: Record<SkynetOverview['events'][number]['kind'], string> = {
  incident: 'Incidente',
  update: 'Aggiornamento',
  reminder: 'Promemoria',
  resolved: 'Risolto',
  change: 'Modifica al firewall',
};

const INTERNAL_LABELS: Record<string, string> = {
  ok: 'Tutto funziona',
  degraded: 'Qualche avviso',
  down: 'Un controllo essenziale non funziona',
  unknown: 'Nessun giro recente',
};

export function agoText(iso: string | null, now: number): string {
  if (!iso) return 'mai';
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes)) return 'mai';
  if (minutes < 1) return 'adesso';
  if (minutes < 60) return minutes === 1 ? '1 minuto fa' : `${minutes} minuti fa`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return hours === 1 ? '1 ora fa' : `${hours} ore fa`;
  return new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
}

function vercelText(data: SkynetOverview): string {
  const vercel = data.signals?.vercel;
  if (!data.configured.vercel) return 'Manca il token: Skynet non vede attacchi e firewall';
  if (!vercel) return 'In attesa del primo giro';
  if (vercel.reachable === false) return 'Non risponde: token scaduto o revocato?';
  return 'Collegato (sola lettura)';
}

function firewallText(data: SkynetOverview): string {
  const vercel = data.signals?.vercel;
  if (!vercel || vercel.firewallEnabled === null) return '—';
  if (!vercel.firewallEnabled) return 'Spento';
  const rules = vercel.skynetRulesActive === null ? '?' : String(vercel.skynetRulesActive);
  const ai = vercel.aiBotsActive ? 'blocco AI attivo' : 'blocco AI spento';
  return `Attivo · versione ${vercel.firewallVersion ?? '?'} · regole Skynet ${rules}/3 · ${ai}`;
}

function healthText(data: SkynetOverview): string {
  const site = data.signals?.site;
  if (!site) return '—';
  if (site.healthOk) return `Risponde in ${site.healthMs ?? '?'} ms`;
  return site.healthStatus === null ? 'Non risponde' : `Risponde HTTP ${site.healthStatus}`;
}

export function SkynetPanel() {
  const [data, setData] = useState<SkynetOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      setData(await apiFetch(ENDPOINT, { schema: SkynetOverviewSchema }));
      setError(null);
    } catch {
      setError('Lo stato di Skynet non è disponibile in questo momento.');
    }
    setNow(Date.now());
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <Panel
      title="Skynet · sentinella"
      description="Guarda il sito ogni minuto e avvisa gli amministratori su Telegram. Solo avvisi: non cambia mai nulla da sola."
    >
      {error ? (
        <p role="alert" className={styles.muted}>
          {error}
        </p>
      ) : null}
      {!data && !error ? <p className={styles.muted}>Caricamento…</p> : null}
      {data ? <SkynetBody data={data} now={now} /> : null}
    </Panel>
  );
}

function SkynetBody({ data, now }: { data: SkynetOverview; now: number }) {
  const Icon =
    data.status === 'incident'
      ? ShieldAlert
      : data.status === 'calm'
        ? ShieldCheck
        : ShieldQuestion;
  const label =
    data.status === 'incident'
      ? `Incidente aperto da ${agoText(data.incidentSince, now).replace(' fa', '')}`
      : data.status === 'calm'
        ? 'Tutto tranquillo'
        : 'In attesa del primo giro';
  const detail =
    data.status === 'incident'
      ? data.incidentKeys.map((key) => PROBLEM_LABELS[key] ?? key).join(', ')
      : data.status === 'calm'
        ? `Ultimo giro ${agoText(data.lastRunAt, now)}`
        : 'Il primo controllo parte entro un minuto dal deploy.';

  return (
    <div className={styles.body}>
      <output className={styles.status} data-status={data.status}>
        <Icon aria-hidden="true" className={styles.statusIcon} />
        <div>
          <p className={styles.statusLabel}>{label}</p>
          <p className={styles.muted}>{detail}</p>
        </div>
      </output>

      <dl className={styles.facts}>
        <dt>Vercel</dt>
        <dd>{vercelText(data)}</dd>
        <dt>Anomalie di traffico (DDoS)</dt>
        <dd>{data.signals?.vercel.anomalies ?? '—'}</dd>
        <dt>Firewall</dt>
        <dd>{firewallText(data)}</dd>
        <dt>Protezione anti-attacco</dt>
        <dd>
          {data.signals?.vercel.attackMode === null || !data.signals
            ? '—'
            : data.signals.vercel.attackMode
              ? 'Accesa'
              : 'Spenta'}
        </dd>
        <dt>Sito (/health)</dt>
        <dd>{healthText(data)}</dd>
        <dt>Controlli interni</dt>
        <dd>{INTERNAL_LABELS[data.signals?.site.internal ?? 'unknown']}</dd>
        <dt>Avvisi su Telegram</dt>
        <dd>
          {data.configured.telegramRecipients > 0
            ? `${data.configured.telegramRecipients} ${data.configured.telegramRecipients === 1 ? 'chat collegata' : 'chat collegate'}`
            : 'Nessuna chat: colleghi Telegram da /premi («Ricevi il codice su Telegram»)'}
        </dd>
        <dt>Rapporti</dt>
        <dd>
          {data.configured.ai
            ? 'Scritti da Claude'
            : 'Testo fisso (chiave Anthropic non disponibile)'}
        </dd>
      </dl>

      {!data.configured.vercel ? (
        <div className={styles.hint}>
          <p>
            <strong>Per dare a Skynet gli occhi su Vercel</strong> (attacchi, firewall):
          </p>
          <ol>
            <li>
              Vercel → Account Settings → Tokens → Create: nome «Skynet», ambito il team di Solco.
            </li>
            <li>
              Progetto → Settings → Environment Variables: <code>SKYNET_VERCEL_TOKEN</code>, solo
              Production, segnata come Sensitive.
            </li>
            <li>Nuovo deploy: dal giro successivo Skynet legge Vercel (solo in lettura).</li>
          </ol>
        </div>
      ) : null}

      <div>
        <h3 className={styles.eventsTitle}>Diario</h3>
        {data.events.length === 0 ? (
          <p className={styles.muted}>Nessun avviso finora.</p>
        ) : (
          <ol className={styles.events}>
            {data.events.map((event) => (
              <li key={event.id} className={styles.event} data-severity={event.severity}>
                <p className={styles.eventMeta}>
                  <span>{KIND_LABELS[event.kind]}</span> · {agoText(event.at, now)}
                  {event.notified > 0 ? ' · inviato su Telegram' : ''}
                </p>
                <p className={styles.eventTitle}>{event.title}</p>
                {event.report ? (
                  <details>
                    <summary>Rapporto</summary>
                    <p className={styles.report}>{event.report}</p>
                  </details>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

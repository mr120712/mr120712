'use client';
// @polsia:user-owned — pannello «Skynet» in Amministrazione → Monitoraggio: stato della sentinella
// che guarda il sito ogni minuto (src/lib/skynet/), la chat per farle domande, ultimi segnali,
// configurazione, autodifesa e diario degli avvisi, con il motore post-quantistico. Si aggiorna da
// solo ogni minuto.

import { ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Panel } from '@/components/custom/app-ui/panel';
import { apiFetch } from '@/lib/api-client';
import { type SkynetOverview, SkynetOverviewSchema } from '@/lib/contracts/skynet';
import { EXPECTED_SKYNET_RULES } from '@/lib/skynet/signals';
import { SkynetChat } from './skynet-chat';
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
  hunt: 'Hacker in verifica',
  quantum: 'Motore post-quantistico',
  defense: 'Autodifesa',
};

const DEFENSE_TARGET_LABELS: Record<string, string> = {
  firewall: 'firewall',
  'ai-bots': 'blocco delle AI',
  'skynet-rules': 'regole Skynet',
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
  return 'Collegato';
}

function firewallText(data: SkynetOverview): string {
  const vercel = data.signals?.vercel;
  if (!vercel || vercel.firewallEnabled === null) return '—';
  if (!vercel.firewallEnabled) return 'Spento';
  const rules = vercel.skynetRulesActive === null ? '?' : String(vercel.skynetRulesActive);
  const ai = vercel.aiBotsActive ? 'blocco AI attivo' : 'blocco AI spento';
  return `Attivo · versione ${vercel.firewallVersion ?? '?'} · regole Skynet ${rules}/${EXPECTED_SKYNET_RULES} · ${ai}`;
}

export function huntedText(data: SkynetOverview): string {
  const hunted = data.signals?.vercel.hunted;
  if (hunted === null || hunted === undefined) return '—';
  if (hunted === 0) return 'Nessuno';
  const base = hunted === 1 ? '1 indirizzo' : `${hunted} indirizzi`;
  const long = data.signals?.vercel.huntedLong ?? 0;
  if (long <= 0) return `${base} (24 ore)`;
  return `${base}, di cui ${long === 1 ? '1 prolungato' : `${long} prolungati`} (7 o 30 giorni)`;
}

function listText(items: string[]): string {
  return items.length > 1
    ? `${items.slice(0, -1).join(', ')} e ${items[items.length - 1]}`
    : (items[0] ?? '');
}

/** L'autodifesa in una riga: attiva (e su cosa veglia), in pausa, spenta, ferma su qualcosa. */
export function autodefenseText(data: SkynetOverview): string {
  const auto = data.autodefense;
  if (!auto) return '—';
  if (auto.mode === 'disabled') return 'Spenta (SKYNET_AUTODEFENSE=off): Skynet avvisa soltanto';
  if (auto.mode === 'paused') {
    const until = auto.pausedUntil
      ? new Date(auto.pausedUntil).toLocaleString('it-IT', {
          timeZone: 'Europe/Rome',
          dateStyle: 'short',
          timeStyle: 'short',
        })
      : '';
    return `In pausa${until ? ` fino al ${until}` : ''}: il proprietario la riprende scrivendo «riprendi autodifesa» nella chat`;
  }
  const watching = [
    auto.watching.firewall ? 'firewall' : '',
    auto.watching.aiBots ? 'blocco delle AI' : '',
    auto.watching.rules > 0
      ? `${auto.watching.rules} ${auto.watching.rules === 1 ? 'regola Skynet' : 'regole Skynet'}`
      : '',
  ].filter(Boolean);
  const parts = [
    watching.length > 0
      ? `Attiva · riaccende da sola ${listText(watching)}`
      : 'Attiva · sta imparando cosa è acceso',
  ];
  if (auto.restoredLastHour > 0) {
    parts.push(
      auto.restoredLastHour === 1
        ? "1 ripristino nell'ultima ora"
        : `${auto.restoredLastHour} ripristini nell'ultima ora`,
    );
  }
  const names = (targets: string[]) =>
    listText(targets.map((target) => DEFENSE_TARGET_LABELS[target] ?? target));
  if (auto.standDown.length > 0) {
    parts.push(`ferma su ${names(auto.standDown)}: qualcuno continua a spegnere`);
  }
  if (auto.failing.length > 0) {
    parts.push(`non riesce a riaccendere ${names(auto.failing)}: va fatto a mano`);
  }
  return parts.join(' · ');
}

export function learningText(data: SkynetOverview): string {
  const learning = data.learning;
  if (!learning) return '—';
  if (!learning.learned) {
    return `Sta imparando dal traffico (${learning.runs} ${learning.runs === 1 ? 'giro' : 'giri'}): soglie di sicurezza di partenza`;
  }
  return `Soglia «aggiramento» a ${learning.advancedOffenses} blocchi · ondata a ${learning.waveThreshold} · imparato da ${learning.runs} giri`;
}

function hostsText(hosts: string[]): string {
  return hosts.length > 1
    ? `${hosts.slice(0, -1).join(', ')} e ${hosts[hosts.length - 1]}`
    : (hosts[0] ?? '');
}

export function quantumText(data: SkynetOverview, now: number): string {
  const quantum = data.signals?.quantum;
  if (!quantum) return 'In attesa del primo controllo';
  const when = `controllato ${agoText(quantum.checkedAt, now)}`;
  if (quantum.pq === true) {
    return `Attivo · ${quantum.group} su ${hostsText(quantum.hosts.map((h) => h.host))} · ${when}`;
  }
  if (quantum.pq === false) {
    const refused = quantum.hosts.filter((h) => h.result === 'classic-only').map((h) => h.host);
    return `Assente su ${hostsText(refused)}: solo scambio di chiavi classico · ${when}`;
  }
  if (quantum.hosts.some((h) => h.result === 'unsupported')) {
    return `Non verificabile: il server non conosce ancora ML-KEM · ${when}`;
  }
  return `Non verificabile in questo momento (dominio irraggiungibile) · ${when}`;
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
      description="Guarda il sito ogni minuto e avvisa gli amministratori su Telegram. Le si può fare una domanda: prima di rispondere cerca in tutte le sue fonti. Si protegge da sola: se qualcuno spegne il firewall, il blocco delle AI o una regola «Skynet ·», li riaccende identici a prima e lo dice (autodifesa). Il cacciatore manda alla verifica del browser chi cerca file da hacker (al primo tentativo) o insiste sugli accessi: 24 ore, 7 o 30 giorni per chi attacca anche durante la verifica (su Telegram solo prolungamenti e ondate, il resto nel diario). Impara dagli attacchi (statistiche aggregate, nessun indirizzo IP) e regola da solo alcune soglie di difesa, sempre dentro limiti fissi. Il motore post-quantistico controlla ogni ora che le connessioni resistano anche ai futuri computer quantistici."
    >
      <div className={styles.body}>
        {error ? (
          <p role="alert" className={styles.muted}>
            {error}
          </p>
        ) : null}
        {!data && !error ? <p className={styles.muted}>Caricamento…</p> : null}
        {data ? <SkynetStatus data={data} now={now} /> : null}
        {/* Fuori dallo stato: la conversazione resta anche se un aggiornamento del pannello fallisce. */}
        <SkynetChat onCommand={() => void load()} />
        {data ? <SkynetDetails data={data} now={now} /> : null}
      </div>
    </Panel>
  );
}

function SkynetStatus({ data, now }: { data: SkynetOverview; now: number }) {
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
    <output className={styles.status} data-status={data.status}>
      <Icon aria-hidden="true" className={styles.statusIcon} />
      <div>
        <p className={styles.statusLabel}>{label}</p>
        <p className={styles.muted}>{detail}</p>
      </div>
    </output>
  );
}

function SkynetDetails({ data, now }: { data: SkynetOverview; now: number }) {
  return (
    <>
      <dl className={styles.facts}>
        <dt>Vercel</dt>
        <dd>{vercelText(data)}</dd>
        <dt>Anomalie di traffico (DDoS)</dt>
        <dd>{data.signals?.vercel.anomalies ?? '—'}</dd>
        <dt>Firewall</dt>
        <dd>{firewallText(data)}</dd>
        <dt>Autodifesa</dt>
        <dd>{autodefenseText(data)}</dd>
        <dt>Hacker in verifica</dt>
        <dd>{huntedText(data)}</dd>
        <dt>Apprendimento</dt>
        <dd>{learningText(data)}</dd>
        <dt>Motore post-quantistico</dt>
        <dd>{quantumText(data, now)}</dd>
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

      <details className={styles.quantum}>
        <summary>Cosa resiste ai computer quantistici</summary>
        <ul>
          <li>
            Connessioni HTTPS dei browser recenti: X25519MLKEM768 (ML-KEM, NIST FIPS 203) dalla rete
            di Vercel. Skynet lo verifica ogni ora.
          </li>
          <li>
            Sessioni, link firmati e cancello anti-bot: HMAC-SHA-256 e SHA-256, già resistenti.
          </li>
          <li>
            Token dei servizi collegati e cache delle trascrizioni: AES-256-GCM, già resistente.
          </li>
          <li>Password: scrypt, già resistente.</li>
          <li>
            Accesso alle API di Apple e Google: firme ES256 e RS256 scelte da loro; passeranno al
            post-quantistico quando lo faranno Apple e Google.
          </li>
        </ul>
      </details>

      {data.learning ? (
        <details className={styles.quantum}>
          <summary>Cosa ha imparato Skynet</summary>
          <p className={styles.muted}>{data.learning.note}</p>
          <ul>
            <li>
              Attacchi tipici: {data.learning.pressurePerRun} per giro
              {data.learning.anomalyPerRun > 0
                ? `, ${data.learning.anomalyPerRun} anomalie di traffico per giro`
                : ''}
              .
            </li>
            {data.learning.topReasons.length > 0 ? (
              <li>
                Tecniche più viste:{' '}
                {data.learning.topReasons.map((r) => `${r.reason} ${r.share}%`).join(', ')}.
              </li>
            ) : null}
            {data.learning.busiestHours.length > 0 ? (
              <li>Ore con più attacchi (UTC): {data.learning.busiestHours.join(', ')}.</li>
            ) : null}
            <li>
              Regola da solo la soglia del «sospetto aggiramento» e quella dell'ondata, sempre
              dentro limiti fissi: non può spegnere una protezione, creare un blocco totale o
              salvare un indirizzo.
            </li>
          </ul>
        </details>
      ) : null}

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
            <li>Nuovo deploy: dal giro successivo Skynet legge Vercel e caccia gli hacker.</li>
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
    </>
  );
}

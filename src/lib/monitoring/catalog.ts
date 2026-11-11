// @polsia:user-owned — nomi e spiegazioni dei controlli automatici, usati dal server (stato
// generale) e dalla pagina admin. Nessun import server-only: è sicuro anche nel browser.
import type {
  MonitorCheckId,
  MonitorCheckResult,
  MonitorOverallStatus,
} from '@/lib/contracts/monitoring';

export type MonitorCheckInfo = {
  label: string;
  /** A failing critical check means users cannot use Solco: overall status "down". */
  critical: boolean;
  /** What the check proves, shown in the admin page. */
  help: string;
};

export const MONITOR_CHECKS: Record<MonitorCheckId, MonitorCheckInfo> = {
  database: {
    label: 'Database',
    critical: true,
    help: 'Il database risponde e accetta scritture.',
  },
  signup_write: {
    label: 'Registrazione',
    critical: true,
    help: 'Un nuovo account può essere salvato (prova annullata subito, nessun dato resta).',
  },
  auth_config: {
    label: 'Configurazione accesso',
    critical: true,
    help: 'Segreto di sessione, indirizzo del sito e credenziali Google sono impostati.',
  },
  google_signin: {
    label: 'Accesso con Google',
    critical: true,
    help: 'Google accetta la richiesta di accesso di Solco e mostra la sua pagina di login.',
  },
  youtube_quota: {
    label: 'Quota YouTube',
    critical: false,
    help: 'La chiave YouTube è valida e la quota giornaliera non è finita (si azzera alle 9:00 ora italiana).',
  },
  youtube_search: {
    label: 'Ricerca YouTube',
    critical: false,
    help: 'Una ricerca di prova restituisce video.',
  },
  audius: {
    label: 'Audius',
    critical: false,
    help: 'Il catalogo Audius restituisce brani di tendenza.',
  },
  radio: {
    label: 'Radio',
    critical: false,
    help: 'Radio Browser restituisce stazioni.',
  },
  podcasts: {
    label: 'Podcast',
    critical: false,
    help: 'La ricerca podcast restituisce programmi.',
  },
  jamendo: {
    label: 'Jamendo',
    critical: false,
    help: 'Il catalogo Jamendo risponde (serve JAMENDO_CLIENT_ID).',
  },
  email: {
    label: 'Email',
    critical: false,
    help: 'L’invio delle email (verifica account) è configurato.',
  },
  anthropic: {
    label: 'Ricerca AI',
    critical: false,
    help: 'La chiave Anthropic è valida.',
  },
  stripe: {
    label: 'Pagamenti Stripe',
    critical: false,
    help: 'La chiave Stripe è valida.',
  },
  cron_cleanup: {
    label: 'Pulizia giornaliera',
    critical: false,
    help: 'La pulizia notturna (dati YouTube scaduti, cache) è stata eseguita nelle ultime 50 ore.',
  },
};

/** down if a critical check fails, degraded if any other check fails; warnings never count. */
export function overallStatus(
  results: Pick<MonitorCheckResult, 'id' | 'status'>[],
): MonitorOverallStatus {
  const failing = results.filter((result) => result.status === 'fail');
  if (failing.some((result) => MONITOR_CHECKS[result.id].critical)) return 'down';
  return failing.length > 0 ? 'degraded' : 'ok';
}

export const OVERALL_STATUS_LABELS: Record<MonitorOverallStatus | 'unknown', string> = {
  ok: 'Tutto funziona',
  degraded: 'Qualcosa non funziona',
  down: 'Solco non è utilizzabile',
  unknown: 'Nessun controllo ancora',
};

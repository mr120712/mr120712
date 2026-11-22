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
    help: 'Ricerche YouTube usate oggi e ultima ricerca riuscita, letti senza spendere quota.',
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
    help: 'Le email (verifica account, recupero password) hanno un canale vero: Resend con un mittente su un dominio verificato (EMAIL_FROM), oppure il proxy email della piattaforma. Il mittente di prova di Resend (onboarding@resend.dev) consegna solo al titolare dell’account Resend: è un guasto.',
  },
  anthropic: {
    label: 'Ricerca AI',
    critical: false,
    help: 'La chiave Anthropic è valida.',
  },
  freellmapi: {
    label: 'Riserva AI gratuita (Solco)',
    critical: false,
    help: 'La riserva gratuita delle funzioni AI (chiave FREELLMAPI_API_KEY, o alias FREELLMAPI_TOKEN) accetta la chiave. È best-effort: entra in gioco solo se Claude non è disponibile; non essendo configurata non è un guasto.',
  },
  solco_ai: {
    label: 'Solco AI (trascrizione testi)',
    critical: false,
    help: 'Il motore di trascrizione dei testi (Whisper large-v3 su Groq, chiave GROQ_API_KEY) accetta una prova: un secondo di silenzio generato dal server, nessun brano, costo irrisorio.',
  },
  stripe: {
    label: 'Pagamenti Stripe',
    critical: false,
    help: 'La chiave Stripe è valida.',
  },
  telegram_bot: {
    label: 'Bot Telegram',
    critical: false,
    help: 'Telegram consegna i messaggi al bot (getWebhookInfo): webhook registrato sull’indirizzo di Solco, nessun errore di consegna recente, coda di messaggi in attesa breve. Il cron giornaliero ri-registra il webhook da solo; non configurato = avviso, non guasto.',
  },
  uam: {
    label: 'Cancello anti-bot (UAM)',
    critical: false,
    help: 'Il cancello proof-of-work davanti al sito. Se UAM_MODE è attivo ma UAM_SECRET manca o è sotto 32 caratteri (per esempio dopo una rotazione sbagliata), il cancello si SPEGNE da solo e lascia passare i bot (fail-open): questo controllo diventa rosso e avvisa. UAM_MODE non impostato = avviso, non guasto.',
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

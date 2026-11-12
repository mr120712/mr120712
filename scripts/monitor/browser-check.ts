// @polsia:user-owned — controllo quotidiano di Solco in un vero browser (Chrome), eseguito da
// GitHub Actions (.github/workflows/monitor.yml, job "browser"). Un solo file autonomo, avviato
// con `node scripts/monitor/browser-check.ts` su Node 24 (type stripping integrato): solo
// TypeScript cancellabile, nessun import relativo, nessuna dipendenza npm a parte Playwright,
// caricato a runtime da PLAYWRIGHT_CORE (default 'playwright-core'). Le funzioni pure sono
// esportate per i test unitari; main() parte solo quando il file viene eseguito direttamente.
//
// Per ogni pagina pubblica (computer 1280×800, e la home anche su telefono 390×844):
// errori JavaScript non gestiti → errore; violazioni della Content Security Policy → errore;
// errori in console → avviso; contenuto principale assente o schermata di errore → errore;
// scorrimento orizzontale su telefono → avviso. Gli screenshot delle pagine con errori finiscono
// in monitor-screenshots/. Esito: exit 1 se almeno una pagina ha errori, 0 altrimenti, 2 se lo
// script stesso si interrompe. Tutte le visite stanno in RUN_BUDGET_MS (10 min, sotto il timeout
// di 15 min del job): allo scadere le pagine restanti risultano non controllate, e il riepilogo
// viene scritto comunque, anche se il browser si chiude a metà.
import { realpathSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_BASE_URL = 'https://solcomusic.vercel.app';
export const SCREENSHOT_DIR = 'monitor-screenshots';
export const NAVIGATION_TIMEOUT_MS = 30_000;
/** Dopo l'evento load: il tempo che serve all'app per idratarsi e caricare i dati. */
export const SETTLE_MS = 2_500;
export const RETRY_DELAY_MS = 5_000;
/** Tetto di sicurezza per una singola visita (navigazione + attesa + lettura + screenshot). */
export const VISIT_TIMEOUT_MS = 75_000;
/**
 * Tempo massimo per tutte le visite: il job del workflow ha timeout-minutes: 15 e, se GitHub lo
 * annulla, non resta né il riepilogo né l'email. Le pagine non ancora visitate allo scadere
 * risultano "non controllate" (errore).
 */
export const RUN_BUDGET_MS = 10 * 60_000;
/** Dopo tante visite di fila finite per timeout il sito intero è lento: niente più secondi tentativi. */
export const MAX_SLOW_VISITS_IN_A_ROW = 2;
const STEP_TIMEOUT_MS = 15_000;
const VISIT_TIMEOUT_MESSAGE = 'visit timeout';
const PROBE_TIMEOUT_MESSAGE = 'probe timeout';
export const MAX_CONSOLE_WARNINGS = 5;
/**
 * Sotto questa soglia (e senza un <main> visibile) la pagina è considerata vuota. Conta solo il
 * testo fuori da intestazione, menu, barre laterali e piè di pagina (vedi PAGE_PROBE_SCRIPT).
 */
export const MIN_TEXT_LENGTH = 100;
const MAX_ITEM = 300;
const MAX_CSP_EVENTS = 50;
export const MONITOR_UA_SUFFIX = 'SolcoMonitor/1.0 (+https://github.com/mr120712/mr120712)';

// ---------- Tipi ----------

export type VisitStatus = 'ok' | 'warn' | 'fail';
export type Viewport = 'desktop' | 'mobile';

export type ViewportSpec = {
  width: number;
  height: number;
  isMobile: boolean;
  hasTouch: boolean;
  label: string;
};

export const VIEWPORTS: Record<Viewport, ViewportSpec> = {
  desktop: { width: 1280, height: 800, isMobile: false, hasTouch: false, label: 'computer' },
  mobile: { width: 390, height: 844, isMobile: true, hasTouch: true, label: 'telefono' },
};

export type PublicPage = { path: string; label: string; critical: boolean };
export type Visit = { path: string; label: string; viewport: Viewport };

export type CspViolation = {
  blockedURI: string;
  directive: string;
  /** enforce = bloccato davvero; report = Content-Security-Policy-Report-Only, solo segnalato. */
  disposition: string;
  sourceFile: string;
};
export type ConsoleEntry = { type: string; text: string; url: string };
export type PageErrorEntry = { message: string; stack: string };
export type PageProbe = {
  hasVisibleMain: boolean;
  /** Caratteri di testo visibile fuori da header, footer, nav e aside (la "cornice" del sito). */
  textLength: number;
  /** Testo della schermata di errore di Next/dell'app, se la pagina la mostra. */
  errorScreen: string | null;
  scrollWidth: number;
  /**
   * Larghezza del viewport di layout (documentElement.clientWidth). Non window.innerWidth: con
   * l'emulazione mobile Chrome allarga innerWidth fino al contenuto e lo scorrimento sparisce.
   */
  viewportWidth: number;
  /** Elementi che sporgono oltre il bordo destro (solo se la pagina scorre in orizzontale). */
  overflowing: string[];
};

/** Tutto ciò che il browser ha osservato durante una visita: input di evaluateVisit(). */
export type VisitObservation = {
  /** Indirizzo visitato: un suo errore HTTP non viene ripetuto tra gli errori in console. */
  pageUrl: string;
  httpStatus: number | null;
  navigationError: string | null;
  pageErrors: PageErrorEntry[];
  console: ConsoleEntry[];
  csp: CspViolation[];
  probe: PageProbe | null;
  /** Entrambe le letture della pagina sono scadute: il JavaScript della pagina non risponde. */
  probeTimedOut: boolean;
};

export type VisitVerdict = {
  status: VisitStatus;
  failures: string[];
  warnings: string[];
  /** Host esterni le cui risorse (immagini di radio, podcast, YouTube) non si sono caricate. */
  ignoredHosts: string[];
  ignoredCount: number;
};

export type VisitResult = Visit &
  VisitVerdict & {
    ms: number;
    attempts: number;
    screenshot: string | null;
    /** Fallita per un timeout (navigazione, lettura o visita): segno che il sito è lento. */
    timedOut: boolean;
  };

export type BrowserSummary = {
  status: VisitStatus;
  exitCode: 0 | 1;
  failed: number;
  warned: number;
  passed: number;
  markdown: string;
  text: string;
};

export type SummaryMeta = {
  baseUrl: string;
  startedAt: Date;
  finishedAt: Date;
  browserVersion: string;
};

// ---------- Pagine ----------

/**
 * Copia locale dell'elenco di scripts/monitor/check-site.ts (questo script non può importarlo):
 * un test unitario verifica che i percorsi coincidano.
 */
export const PUBLIC_PAGES: readonly PublicPage[] = [
  { path: '/', label: 'Home', critical: true },
  { path: '/search', label: 'Cerca', critical: false },
  { path: '/generi', label: 'Generi', critical: false },
  // The genre API recognises the monitor's User-Agent and serves saved results only: this visit
  // never spends a YouTube search (src/app/api/music/genres/[slug]/route.ts).
  { path: '/generi/techno', label: 'Genere Techno', critical: false },
  { path: '/radio', label: 'Radio', critical: false },
  { path: '/podcasts', label: 'Podcast', critical: false },
  { path: '/library', label: 'Libreria', critical: false },
  { path: '/registra', label: 'Registra', critical: false },
  { path: '/pool', label: 'Record Pool', critical: false },
  { path: '/community', label: 'Community', critical: false },
  { path: '/piani', label: 'Piani', critical: false },
  { path: '/premi', label: 'Invita amici', critical: false },
  { path: '/app', label: 'Installa l’app', critical: false },
  { path: '/flashcards', label: 'Flashcard', critical: false },
  { path: '/apple-music', label: 'Apple Music', critical: false },
  { path: '/privacy', label: 'Privacy', critical: false },
  { path: '/terms', label: 'Termini', critical: false },
  { path: '/login', label: 'Accedi', critical: false },
  { path: '/signup', label: 'Registrati', critical: false },
];

/** Tutte le pagine su computer; la home anche su telefono, subito dopo. */
export function plannedVisits(pages: readonly PublicPage[] = PUBLIC_PAGES): Visit[] {
  const visits: Visit[] = [];
  for (const page of pages) {
    visits.push({ path: page.path, label: page.label, viewport: 'desktop' });
    if (page.path === '/') visits.push({ path: page.path, label: page.label, viewport: 'mobile' });
  }
  return visits;
}

/** '/' → 'home', '/generi/techno' → 'generi-techno': nome di file sicuro per gli screenshot. */
export function slug(path: string): string {
  const cleaned = path
    .split(/[?#]/)[0]
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned || 'home';
}

export function screenshotPath(visit: Pick<Visit, 'path' | 'viewport'>): string {
  return `${SCREENSHOT_DIR}/${slug(visit.path)}-${visit.viewport}.png`;
}

export function visitLabel(visit: Pick<Visit, 'path' | 'label' | 'viewport'>): string {
  return `${visit.label} (${visit.path}) · ${VIEWPORTS[visit.viewport].label}`;
}

// ---------- Utilità ----------

export function clip(text: string, max = MAX_ITEM): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * I log di GitHub Actions di un repository pubblico sono pubblici: dagli indirizzi si tolgono
 * query string e frammento (token firmati, parametri di ricerca) e il testo viene accorciato.
 */
export function sanitize(text: string, max = MAX_ITEM): string {
  const withoutQueries = text.replace(/\b(?:https?|wss?):\/\/[^\s'"<>()`]+/gi, (raw) => {
    const trailing = /[.,;:!]+$/.exec(raw)?.[0] ?? '';
    const url = trailing ? raw.slice(0, -trailing.length) : raw;
    try {
      const parsed = new URL(url);
      return `${parsed.origin}${parsed.pathname}${trailing}`;
    } catch {
      return `${url.split(/[?#]/)[0] ?? ''}${trailing}`;
    }
  });
  return clip(withoutQueries, max);
}

function originOf(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** Ritorna 'own' se l'URL è di Solco, 'external' se è di un altro sito, null se non è un URL web. */
export function urlOwner(raw: string, baseOrigin: string): 'own' | 'external' | null {
  const origin = originOf(raw);
  if (origin === null) return null;
  return origin === baseOrigin ? 'own' : 'external';
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

/** Al massimo `max` voci, più una riga "… e altri N". */
export function limitList(items: string[], max: number): string[] {
  const unique = dedupe(items);
  if (unique.length <= max) return unique;
  return [...unique.slice(0, max), `… e altri ${unique.length - max}`];
}

/** User-Agent di un Chrome normale (desktop o Android) più la firma del monitor. */
export function userAgentFor(viewport: Viewport, browserVersion: string): string {
  const major = /^(\d+)/.exec(browserVersion)?.[1] ?? '130';
  const platform =
    viewport === 'mobile'
      ? `Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`
      : `X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  return `Mozilla/5.0 (${platform} ${MONITOR_UA_SUFFIX}`;
}

export function normalizeBaseUrl(value: string | undefined): string {
  const url = new URL(value?.trim() || DEFAULT_BASE_URL);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('BASE_URL deve essere un indirizzo http(s)');
  }
  return url.origin;
}

// ---------- Valutazione (pura) ----------

/** Breve descrizione italiana di un errore di navigazione di Playwright (mai il messaggio intero). */
export function describeNavigationError(
  message: string,
  timeoutMs = NAVIGATION_TIMEOUT_MS,
): string {
  if (message === VISIT_TIMEOUT_MESSAGE) {
    return `La visita non è finita entro ${Math.round(VISIT_TIMEOUT_MS / 1000)} s (pagina bloccata?)`;
  }
  if (/timeout/i.test(message)) {
    return `La pagina non ha finito di caricarsi entro ${Math.round(timeoutMs / 1000)} s`;
  }
  const code = /net::(ERR_[A-Z0-9_]+)/.exec(message)?.[1];
  if (code) return `La pagina non si è caricata (errore di rete ${code})`;
  return 'La pagina non si è caricata (errore di navigazione)';
}

const STACK_URL = /\b(?:https?):\/\/[^\s'"<>()]+/gi;

/**
 * Un errore non gestito il cui stack punta solo a script di altri siti (embed, widget) non
 * dipende dal codice di Solco: diventa un avviso. Contano solo le righe "at …" dello stack (il
 * messaggio può citare indirizzi qualsiasi); senza URL nello stack l'errore resta di Solco.
 */
export function pageErrorOwner(error: PageErrorEntry, baseOrigin: string): 'own' | 'external' {
  const frames = error.stack
    .split('\n')
    .filter((line) => /^\s*at\s/.test(line))
    .join('\n');
  const urls = frames.match(STACK_URL) ?? [];
  const owners = urls
    .map((url) => urlOwner(url.replace(/:\d+(?::\d+)?$/, ''), baseOrigin))
    .filter((owner) => owner !== null);
  if (owners.length === 0) return 'own';
  return owners.includes('own') ? 'own' : 'external';
}

/** Errori "recuperabili" di React: l'HTML del server non coincide e React ridisegna nel browser. */
const HYDRATION_REACT_CODES = new Set(['418', '419', '422', '423', '425']);

/** Testo breve di un errore JavaScript; hydration = errore di idratazione React (recuperabile). */
export function describePageError(message: string): { text: string; hydration: boolean } {
  const code = /Minified React error #(\d+)/.exec(message)?.[1];
  if (code) {
    return {
      text: `React #${code} (https://react.dev/errors/${code})`,
      hydration: HYDRATION_REACT_CODES.has(code),
    };
  }
  return {
    text: sanitize(message || 'errore senza messaggio', 200),
    hydration: /hydrat/i.test(message),
  };
}

const CSP_MENTION = /content[- ]security[- ]policy|refused to/i;
const CSP_BLOCK = /refused to|violates the following content security policy directive/i;
/**
 * eval/WebAssembly bloccati dalla CSP: molte librerie provano eval dentro un try/catch (zod v4,
 * per esempio) e proseguono senza. Se il codice si rompe davvero resta un EvalError non gestito,
 * che pageerror segnala come errore.
 */
const EVAL_BLOCKED_URIS = new Set(['eval', 'wasm-eval']);
const CONSOLE_EVAL_BLOCK =
  /refused to (?:evaluate a string as javascript|compile or instantiate webassembly)|'(?:unsafe|wasm-unsafe|wasm)-eval' is not an allowed source/i;
export const CSP_EVAL_WARNING =
  'La CSP ha impedito eval (probabilmente il controllo di una libreria)';
/** Messaggi di siti incorporati che rifiutano di essere mostrati in un frame: non è la CSP di Solco. */
const FRAME_REFUSAL = /frame-ancestors|x-frame-options/i;
const RESOURCE_FAILURE =
  /^Failed to load resource: (?:the server responded with a status of (\d{3})|net::(ERR_[A-Z0-9_]+))/;

function describeResource(url: string, baseOrigin: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin === baseOrigin ? parsed.pathname : `${parsed.origin}${parsed.pathname}`;
  } catch {
    return sanitize(url, 120);
  }
}

function sameDocument(a: string, b: string): boolean {
  try {
    const first = new URL(a);
    const second = new URL(b);
    return first.origin === second.origin && first.pathname === second.pathname;
  } catch {
    return false;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'sconosciuto';
  }
}

/**
 * Decide l'esito di una visita a partire da ciò che il browser ha osservato.
 * fail: pagina non caricata o HTTP >= 400, errore JavaScript di Solco non gestito, CSP che
 * blocca qualcosa, schermata di errore, contenuto principale assente.
 * warn: errori in console, errori di script esterni, CSP solo-report o di contenuti incorporati,
 * scorrimento orizzontale su telefono. Le risorse esterne non caricate sono solo contate.
 */
export function evaluateVisit(
  viewport: Viewport,
  observation: VisitObservation,
  baseOrigin: string,
): VisitVerdict {
  const failures: string[] = [];
  const warnings: string[] = [];
  const consoleWarnings: string[] = [];
  const ignoredHosts: string[] = [];
  let ignoredCount = 0;

  const pageFailed =
    observation.navigationError !== null ||
    (observation.httpStatus !== null && observation.httpStatus >= 400);
  if (observation.navigationError !== null) {
    failures.push(describeNavigationError(observation.navigationError));
  } else if (pageFailed) {
    failures.push(`La pagina risponde HTTP ${observation.httpStatus}`);
  }

  for (const error of observation.pageErrors) {
    const { text, hydration } = describePageError(error.message);
    if (pageErrorOwner(error, baseOrigin) === 'external') {
      warnings.push(`Errore in uno script esterno: ${text}`);
    } else if (hydration) {
      // React lo segnala come errore globale ma recupera da solo: la pagina funziona.
      warnings.push(
        `Errore di idratazione ${text}: l’HTML del server e quello del browser non coincidono, ` +
          'React ha ridisegnato la pagina nel browser',
      );
    } else {
      failures.push(`Errore JavaScript non gestito: ${text}`);
    }
  }

  let enforcedCsp = 0;
  let reportedCsp = 0;
  for (const violation of observation.csp) {
    const blocked = sanitize(violation.blockedURI || 'sconosciuto', 150);
    const directive = sanitize(violation.directive || 'direttiva sconosciuta', 60);
    if (violation.disposition === 'report') {
      reportedCsp += 1;
      warnings.push(`CSP in prova (solo report) bloccherebbe ${blocked} (${directive})`);
    } else if (EVAL_BLOCKED_URIS.has(violation.blockedURI)) {
      // Non conta tra le violazioni bloccanti: i messaggi in console di altri blocchi restano.
      warnings.push(CSP_EVAL_WARNING);
    } else {
      enforcedCsp += 1;
      failures.push(`La CSP ha bloccato ${blocked} (${directive})`);
    }
  }

  const consoleCspFailures: string[] = [];
  const consoleCspReports: string[] = [];
  for (const entry of observation.console) {
    const owner = urlOwner(entry.url, baseOrigin);
    const text = sanitize(entry.text, 220);
    if (CSP_MENTION.test(entry.text)) {
      if (FRAME_REFUSAL.test(entry.text)) {
        warnings.push(`Un contenuto esterno rifiuta di essere incorporato: ${text}`);
      } else if (owner === 'external') {
        warnings.push(`CSP di un contenuto esterno (${hostOf(entry.url)}): ${text}`);
      } else if (/report[- ]only/i.test(entry.text)) {
        consoleCspReports.push(`CSP in prova (solo report): ${text}`);
      } else if (CONSOLE_EVAL_BLOCK.test(entry.text)) {
        warnings.push(CSP_EVAL_WARNING);
      } else if (CSP_BLOCK.test(entry.text)) {
        consoleCspFailures.push(`Violazione CSP: ${text}`);
      } else {
        warnings.push(`Avviso CSP: ${text}`);
      }
      continue;
    }
    if (entry.type !== 'error') continue;
    const resource = RESOURCE_FAILURE.exec(entry.text);
    if (resource) {
      if (pageFailed && sameDocument(entry.url, observation.pageUrl)) continue;
      if (owner === 'external') {
        ignoredCount += 1;
        ignoredHosts.push(hostOf(entry.url));
        continue;
      }
      const reason = resource[1] ? `HTTP ${resource[1]}` : resource[2];
      const where = entry.url ? describeResource(entry.url, baseOrigin) : 'indirizzo sconosciuto';
      consoleWarnings.push(`Risorsa non caricata (${reason}): ${sanitize(where, 150)}`);
      continue;
    }
    const from = owner === 'external' ? ` (da ${hostOf(entry.url)})` : '';
    consoleWarnings.push(`Errore in console${from}: ${text}`);
  }
  // Gli eventi securitypolicyviolation e i messaggi in console descrivono le stesse violazioni:
  // i messaggi servono solo quando nessun evento è stato registrato.
  if (enforcedCsp === 0) failures.push(...consoleCspFailures);
  if (reportedCsp === 0) warnings.push(...consoleCspReports);
  warnings.push(...limitList(consoleWarnings, MAX_CONSOLE_WARNINGS));

  const probe = observation.probe;
  if (observation.navigationError === null) {
    if (probe === null) {
      failures.push(
        observation.probeTimedOut
          ? 'La pagina non risponde (JavaScript bloccato?)'
          : 'Impossibile leggere il contenuto della pagina',
      );
    } else {
      if (probe.errorScreen !== null) {
        failures.push(
          `La pagina mostra la schermata di errore ("${sanitize(probe.errorScreen, 80)}")`,
        );
      }
      if (!probe.hasVisibleMain && probe.textLength <= MIN_TEXT_LENGTH) {
        failures.push(
          'Contenuto principale non visibile (nessun <main> visibile, ' +
            `${probe.textLength} caratteri di testo fuori da intestazione, menu e piè di pagina)`,
        );
      }
      if (viewport === 'mobile' && probe.scrollWidth > probe.viewportWidth + 1) {
        const culprits =
          probe.overflowing.length > 0
            ? `; sporgono: ${probe.overflowing.map((item) => sanitize(item, 60)).join(', ')}`
            : '';
        warnings.push(
          `Scorrimento orizzontale sul telefono: pagina larga ${probe.scrollWidth}px su ${probe.viewportWidth}px${culprits}`,
        );
      }
    }
  }

  const uniqueFailures = dedupe(failures);
  const uniqueWarnings = dedupe(warnings);
  return {
    status: uniqueFailures.length > 0 ? 'fail' : uniqueWarnings.length > 0 ? 'warn' : 'ok',
    failures: uniqueFailures,
    warnings: uniqueWarnings,
    ignoredHosts: dedupe(ignoredHosts).sort(),
    ignoredCount,
  };
}

/**
 * Una visita fallita viene ripetuta una volta: se il secondo tentativo va, gli errori del primo
 * restano visibili come avviso (problema intermittente), senza far fallire il controllo.
 */
export function mergeAttempts(first: VisitVerdict, second: VisitVerdict): VisitVerdict {
  if (second.status === 'fail') return second;
  const transient = `Errore solo al primo tentativo: ${first.failures.join('; ')}`;
  return {
    ...second,
    status: 'warn',
    warnings: [clip(transient), ...second.warnings],
  };
}

// ---------- Riepilogo (puro) ----------

const ROME = new Intl.DateTimeFormat('it-IT', {
  timeZone: 'Europe/Rome',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatRome(date: Date): string {
  return Number.isFinite(date.getTime()) ? ROME.format(date) : 'data sconosciuta';
}

const ICONS: Record<VisitStatus, string> = { ok: '✅', warn: '⚠️', fail: '❌' };
const TEXT_TAGS: Record<VisitStatus, string> = {
  ok: '[OK]    ',
  warn: '[AVVISO]',
  fail: '[ERRORE]',
};

function cell(text: string): string {
  return clip(text, MAX_ITEM).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/</g, '&lt;');
}

function pages(count: number): string {
  return count === 1 ? '1 pagina' : `${count} pagine`;
}

function headline(failed: number, warned: number, total: number): string {
  if (failed > 0) {
    return `❌ ${failed === 1 ? '1 pagina su' : `${failed} pagine su`} ${total} ha${failed === 1 ? '' : 'nno'} errori nel browser`;
  }
  if (warned > 0) {
    return `⚠️ Nessun errore nel browser; ${pages(warned)} con avvisi`;
  }
  return `✅ Tutte le ${total} pagine funzionano nel browser`;
}

function rowDetail(result: VisitResult): string {
  const items = result.status === 'fail' ? result.failures : result.warnings;
  const first = items[0];
  if (!first) return result.attempts > 1 ? 'Tutto a posto (al secondo tentativo)' : 'Tutto a posto';
  return items.length > 1 ? `${first} (+${items.length - 1})` : first;
}

export function summarizeBrowserResults(
  results: readonly VisitResult[],
  meta: SummaryMeta,
): BrowserSummary {
  const failed = results.filter((result) => result.status === 'fail').length;
  const warned = results.filter((result) => result.status === 'warn').length;
  const passed = results.length - failed - warned;
  const status: VisitStatus = failed > 0 ? 'fail' : warned > 0 ? 'warn' : 'ok';
  const title = headline(failed, warned, results.length);
  const seconds = ((meta.finishedAt.getTime() - meta.startedAt.getTime()) / 1000)
    .toFixed(1)
    .replace('.', ',');
  const ignoredCount = results.reduce((sum, result) => sum + result.ignoredCount, 0);
  const ignoredHosts = dedupe(results.flatMap((result) => result.ignoredHosts)).sort();
  const ignoredNote =
    ignoredCount > 0
      ? `Ignorati ${ignoredCount} errori di caricamento di immagini o file di altri siti ` +
        `(${limitList(ignoredHosts, 6).join(', ')}): non dipendono da Solco.`
      : null;

  const markdown = [
    '## Controllo nel browser — Solco',
    '',
    `**${title}**`,
    '',
    `Controllato ${meta.baseUrl} il ${formatRome(meta.finishedAt)} (ora italiana) con Chrome ` +
      `${cell(meta.browserVersion)}, in ${seconds} s.`,
    '',
    '| Esito | Pagina | Schermo | Dettaglio | ms |',
    '| :---: | --- | --- | --- | ---: |',
    ...results.map(
      (result) =>
        `| ${ICONS[result.status]} | ${cell(`${result.label} (${result.path})`)} | ` +
        `${VIEWPORTS[result.viewport].label} | ${cell(rowDetail(result))} | ${result.ms} |`,
    ),
    '',
    '### Errori',
    '',
  ];
  const failing = results.filter((result) => result.status === 'fail');
  if (failing.length === 0) markdown.push('Nessuno.');
  for (const result of failing) {
    const retried = result.attempts > 1 ? ' (errore anche al secondo tentativo)' : '';
    markdown.push(`- ❌ **${cell(visitLabel(result))}**${retried}`);
    for (const item of result.failures) markdown.push(`  - ${cell(item)}`);
    for (const item of result.warnings) markdown.push(`  - ⚠️ ${cell(item)}`);
    if (result.screenshot) {
      markdown.push(`  - Screenshot: \`${result.screenshot}\` (artefatto "monitor-screenshots")`);
    }
  }
  markdown.push('', '### Avvisi', '');
  const warning = results.filter((result) => result.status === 'warn');
  if (warning.length === 0) markdown.push('Nessuno.');
  for (const result of warning) {
    markdown.push(`- ⚠️ **${cell(visitLabel(result))}**`);
    for (const item of result.warnings) markdown.push(`  - ${cell(item)}`);
  }
  if (ignoredNote) markdown.push('', `> ${cell(ignoredNote)}`);

  const text = [
    `Controllo nel browser: ${meta.baseUrl} (${formatRome(meta.finishedAt)}, ora italiana, Chrome ${meta.browserVersion})`,
    ...results.map(
      (result) =>
        `${TEXT_TAGS[result.status]} ${visitLabel(result)}: ${rowDetail(result)} (${result.ms} ms)`,
    ),
  ];
  for (const result of results.filter((item) => item.status !== 'ok')) {
    for (const item of result.failures) text.push(`  ERRORE ${visitLabel(result)}: ${item}`);
    for (const item of result.warnings) text.push(`  AVVISO ${visitLabel(result)}: ${item}`);
    if (result.screenshot) text.push(`  Screenshot: ${result.screenshot}`);
  }
  if (ignoredNote) text.push(`Nota: ${ignoredNote}`);
  text.push(`Esito: ${title.replace(/^\S+\s/, '')}`);

  return {
    status,
    exitCode: failed > 0 ? 1 : 0,
    failed,
    warned,
    passed,
    markdown: `${markdown.join('\n')}\n`,
    text: `${text.join('\n')}\n`,
  };
}

function escapeAnnotation(text: string, property = false): string {
  const escaped = text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  return property ? escaped.replace(/:/g, '%3A').replace(/,/g, '%2C') : escaped;
}

/** GitHub workflow commands: ogni pagina con errori diventa un'annotazione sulla pagina del job. */
export function renderAnnotations(results: readonly VisitResult[]): string {
  return results
    .filter((result) => result.status === 'fail')
    .map(
      (result) =>
        `::error title=${escapeAnnotation(`Solco nel browser: ${visitLabel(result)}`, true)}::` +
        `${escapeAnnotation(clip(result.failures.join('; '), 600))}\n`,
    )
    .join('');
}

// ---------- Browser ----------

/** Solo la parte di Playwright usata qui: il modulo è caricato a runtime, senza tipi npm. */
export type PwConsoleMessage = { type(): string; text(): string; location(): { url?: string } };
export type PwResponse = { status(): number };
export type PwPage = {
  on(event: 'pageerror', listener: (error: Error) => void): unknown;
  on(event: 'console', listener: (message: PwConsoleMessage) => void): unknown;
  goto(url: string, options: { waitUntil: 'load'; timeout: number }): Promise<PwResponse | null>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  screenshot(options: { path: string; fullPage: boolean; timeout: number }): Promise<unknown>;
};
export type PwContext = {
  addInitScript(script: string): Promise<void>;
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
};
export type PwContextOptions = {
  viewport: { width: number; height: number };
  isMobile: boolean;
  hasTouch: boolean;
  deviceScaleFactor: number;
  userAgent: string;
  locale: string;
  timezoneId: string;
};
export type PwBrowser = {
  version(): string;
  newContext(options: PwContextOptions): Promise<PwContext>;
  close(): Promise<void>;
  /** false quando il processo del browser si è chiuso o si è scollegato. */
  isConnected?(): boolean;
};
export type PwChromium = {
  launch(options: { headless: boolean; channel?: string }): Promise<PwBrowser>;
};

/** Registra in window.__cspViolations le violazioni CSP del documento (iniettato prima di ogni script). */
export const CSP_INIT_SCRIPT = `(() => {
  if (Object.prototype.hasOwnProperty.call(window, '__cspViolations')) return;
  const list = [];
  Object.defineProperty(window, '__cspViolations', { value: list });
  window.addEventListener('securitypolicyviolation', (event) => {
    if (list.length >= ${MAX_CSP_EVENTS}) return;
    list.push({
      blockedURI: String(event.blockedURI || ''),
      directive: String(event.effectiveDirective || event.violatedDirective || ''),
      disposition: String(event.disposition || 'enforce'),
      sourceFile: String(event.sourceFile || ''),
    });
  }, true);
})();`;

/**
 * Legge dal documento principale: <main> visibile, testo, schermata di errore, larghezza.
 * textLength esclude la cornice del sito (header, footer, nav, aside e i ruoli equivalenti fuori
 * da <main>), così una pagina vuota resta vuota anche se il menu o il piè di pagina crescono.
 * Gli elementi senza box (display: none) sono saltati: il loro innerText è l'intero textContent.
 */
export const PAGE_PROBE_SCRIPT = `(() => {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const body = document.body;
  const text = body ? body.innerText.trim() : '';
  const shellSelector = 'header, footer, nav, aside, [role=banner], [role=contentinfo], [role=navigation]';
  let shellLength = 0;
  if (body) {
    for (const element of body.querySelectorAll(shellSelector)) {
      if (element.closest('main')) continue;
      const parent = element.parentElement;
      if (parent && parent.closest(shellSelector)) continue;
      if (element.getClientRects().length === 0) continue;
      shellLength += (element.innerText || '').trim().length;
    }
  }
  const headings = Array.from(document.querySelectorAll('h1, h2')).map((h) => (h.textContent || '').trim());
  const errorHeading = headings.find((h) => h === 'Something went wrong' || h === 'Qualcosa è andato storto');
  const nextError = /Application error: a (?:client|server)-side exception has occurred/.exec(text);
  const viewportWidth = document.documentElement.clientWidth;
  const scrollWidth = document.documentElement.scrollWidth;
  const overflowing = [];
  if (body && scrollWidth > viewportWidth + 1) {
    const clipped = (element) => {
      for (let node = element; node && node !== body; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.position === 'fixed') return true;
        if (node !== element && style.overflowX !== 'visible') return true;
      }
      return false;
    };
    const describe = (element) => {
      const id = element.id ? '#' + element.id : '';
      const classes = typeof element.className === 'string'
        ? element.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2).map((c) => '.' + c).join('')
        : '';
      return element.tagName.toLowerCase() + id + classes;
    };
    for (const element of body.querySelectorAll('*')) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.right <= viewportWidth + 1) continue;
      const parent = element.parentElement;
      if (parent && parent !== body && parent.getBoundingClientRect().right > viewportWidth + 1) continue;
      if (clipped(element)) continue;
      overflowing.push(describe(element));
      if (overflowing.length >= 3) break;
    }
  }
  return {
    hasVisibleMain: Array.from(document.querySelectorAll('main')).some(visible),
    textLength: Math.max(0, text.length - shellLength),
    errorScreen: errorHeading || (nextError ? nextError[0] : null),
    scrollWidth,
    viewportWidth,
    overflowing,
  };
})()`;

function parseProbe(value: unknown): PageProbe | null {
  if (!isRecord(value)) return null;
  const numbers = [value.textLength, value.scrollWidth, value.viewportWidth];
  if (!numbers.every((item) => typeof item === 'number' && Number.isFinite(item))) return null;
  return {
    hasVisibleMain: value.hasVisibleMain === true,
    textLength: value.textLength as number,
    errorScreen: typeof value.errorScreen === 'string' ? value.errorScreen : null,
    scrollWidth: value.scrollWidth as number,
    viewportWidth: value.viewportWidth as number,
    overflowing: Array.isArray(value.overflowing)
      ? value.overflowing.filter((item): item is string => typeof item === 'string').slice(0, 3)
      : [],
  };
}

function parseCsp(value: unknown): CspViolation[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item) => ({
    blockedURI: asString(item.blockedURI),
    directive: asString(item.directive),
    disposition: asString(item.disposition) || 'enforce',
    sourceFile: asString(item.sourceFile),
  }));
}

/** Rifiuta se la promessa non si risolve entro `ms` (la promessa originale resta in sospeso). */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export type BrowserDeps = {
  baseUrl: string;
  browser: PwBrowser;
  browserVersion: string;
  sleep: (ms: number) => Promise<void>;
  /** Millisecondi monotoni, per misurare le durate. */
  clock: () => number;
  settleMs: number;
  retryDelayMs: number;
  navigationTimeoutMs: number;
  visitTimeoutMs: number;
  /** Tempo massimo per tutte le visite, misurato con clock() dall'inizio di main(). */
  runBudgetMs: number;
  /** Crea la cartella degli screenshot e ritorna il percorso del file, o null se non si può. */
  prepareScreenshot: (relativePath: string) => Promise<string | null>;
};

export type CheckVisitOptions = {
  /** Istante (in clock()) di fine del tempo a disposizione: niente secondo tentativo se non basta. */
  deadline?: number;
  /** false quando il sito intero è lento: un fallimento non viene ripetuto. */
  allowRetry?: boolean;
};

type Attempt = { verdict: VisitVerdict; ms: number; page: PwPage | null; timedOut: boolean };

function isTimeoutMessage(message: string | null): boolean {
  return message !== null && /timeout/i.test(message);
}

/** Durata massima ragionevole di un secondo tentativo, attesa prima del tentativo compresa. */
function retryCostMs(deps: BrowserDeps): number {
  return deps.navigationTimeoutMs + deps.settleMs + 2 * STEP_TIMEOUT_MS + deps.retryDelayMs;
}

async function observe(deps: BrowserDeps, page: PwPage, url: string): Promise<VisitObservation> {
  const observation: VisitObservation = {
    pageUrl: url,
    httpStatus: null,
    navigationError: null,
    pageErrors: [],
    console: [],
    csp: [],
    probe: null,
    probeTimedOut: false,
  };
  page.on('pageerror', (error) => {
    if (observation.pageErrors.length >= 20) return;
    observation.pageErrors.push({
      message: asString(error?.message) || String(error),
      stack: asString(error?.stack),
    });
  });
  page.on('console', (message) => {
    if (observation.console.length >= 200) return;
    const type = message.type();
    const text = message.text();
    if (type !== 'error' && !CSP_MENTION.test(text)) return;
    let url = '';
    try {
      url = message.location().url ?? '';
    } catch {
      // posizione non disponibile
    }
    observation.console.push({ type, text, url });
  });

  try {
    const response = await page.goto(url, {
      waitUntil: 'load',
      timeout: deps.navigationTimeoutMs,
    });
    observation.httpStatus = response ? response.status() : null;
  } catch (error) {
    observation.navigationError = error instanceof Error ? error.message : String(error);
    return observation;
  }
  await page.waitForTimeout(deps.settleMs);

  // Un reindirizzamento lato client durante la lettura distrugge il contesto: si riprova una volta.
  let timeouts = 0;
  let rounds = 0;
  for (; rounds < 2 && observation.probe === null; rounds += 1) {
    if (rounds > 0) await page.waitForTimeout(1_000);
    try {
      observation.probe = parseProbe(
        await withTimeout(page.evaluate(PAGE_PROBE_SCRIPT), STEP_TIMEOUT_MS, PROBE_TIMEOUT_MESSAGE),
      );
      observation.csp = parseCsp(
        await withTimeout(
          page.evaluate('window.__cspViolations || []'),
          STEP_TIMEOUT_MS,
          PROBE_TIMEOUT_MESSAGE,
        ),
      );
    } catch (error) {
      observation.probe = null;
      if (error instanceof Error && error.message === PROBE_TIMEOUT_MESSAGE) timeouts += 1;
    }
  }
  observation.probeTimedOut = observation.probe === null && timeouts === rounds;
  return observation;
}

async function attemptVisit(
  deps: BrowserDeps,
  visit: Visit,
): Promise<Attempt & { close: () => Promise<void> }> {
  const spec = VIEWPORTS[visit.viewport];
  const started = deps.clock();
  const context = await deps.browser.newContext({
    viewport: { width: spec.width, height: spec.height },
    isMobile: spec.isMobile,
    hasTouch: spec.hasTouch,
    deviceScaleFactor: spec.isMobile ? 3 : 1,
    userAgent: userAgentFor(visit.viewport, deps.browserVersion),
    locale: 'it-IT',
    timezoneId: 'Europe/Rome',
  });
  const close = async () => {
    try {
      await withTimeout(context.close(), STEP_TIMEOUT_MS, 'close timeout');
    } catch {
      // il contesto è già chiuso
    }
  };
  const target = new URL(visit.path, `${deps.baseUrl}/`).href;
  let page: PwPage | null = null;
  try {
    await context.addInitScript(CSP_INIT_SCRIPT);
    page = await context.newPage();
    const observation = await withTimeout(
      observe(deps, page, target),
      deps.visitTimeoutMs,
      VISIT_TIMEOUT_MESSAGE,
    );
    const verdict = evaluateVisit(visit.viewport, observation, deps.baseUrl);
    const timedOut = observation.probeTimedOut || isTimeoutMessage(observation.navigationError);
    return { verdict, ms: Math.max(0, Math.round(deps.clock() - started)), page, timedOut, close };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const verdict = evaluateVisit(
      visit.viewport,
      {
        pageUrl: target,
        httpStatus: null,
        navigationError: message,
        pageErrors: [],
        console: [],
        csp: [],
        probe: null,
        probeTimedOut: false,
      },
      deps.baseUrl,
    );
    const timedOut = isTimeoutMessage(message);
    return { verdict, ms: Math.max(0, Math.round(deps.clock() - started)), page, timedOut, close };
  }
}

async function takeScreenshot(
  deps: BrowserDeps,
  page: PwPage | null,
  visit: Visit,
): Promise<string | null> {
  if (!page) return null;
  const relative = screenshotPath(visit);
  try {
    const target = await deps.prepareScreenshot(relative);
    if (!target) return null;
    await withTimeout(
      page.screenshot({ path: target, fullPage: true, timeout: STEP_TIMEOUT_MS }),
      STEP_TIMEOUT_MS + 5_000,
      'screenshot timeout',
    );
    return relative;
  } catch {
    return null;
  }
}

/**
 * Una visita completa: nuovo contesto (come un visitatore nuovo), un secondo tentativo se
 * fallisce, purché sia permesso e il tempo rimasto basti per un tentativo intero.
 */
export async function checkVisit(
  deps: BrowserDeps,
  visit: Visit,
  options: CheckVisitOptions = {},
): Promise<VisitResult> {
  let attempt = await attemptVisit(deps, visit);
  let verdict = attempt.verdict;
  let attempts = 1;
  const timeLeft =
    options.deadline === undefined ? Number.POSITIVE_INFINITY : options.deadline - deps.clock();
  const retry = options.allowRetry !== false && timeLeft >= retryCostMs(deps);
  if (verdict.status === 'fail' && retry) {
    await attempt.close();
    await deps.sleep(deps.retryDelayMs);
    const first = verdict;
    attempt = await attemptVisit(deps, visit);
    attempts = 2;
    verdict = mergeAttempts(first, attempt.verdict);
  }
  const screenshot =
    verdict.status === 'fail' ? await takeScreenshot(deps, attempt.page, visit) : null;
  await attempt.close();
  const timedOut = verdict.status === 'fail' && attempt.timedOut;
  return { ...visit, ...verdict, ms: attempt.ms, attempts, screenshot, timedOut };
}

/** Risultato di una visita che non è stata fatta (tempo finito, browser chiuso). */
export function uncheckedVisit(visit: Visit, reason: string, attempts = 0): VisitResult {
  return {
    ...visit,
    status: 'fail',
    failures: [reason],
    warnings: [],
    ignoredHosts: [],
    ignoredCount: 0,
    ms: 0,
    attempts,
    screenshot: null,
    timedOut: false,
  };
}

export const BUDGET_EXHAUSTED_MESSAGE = 'Non controllata: tempo massimo del controllo esaurito';
const BROWSER_GONE_MESSAGE = 'Non controllata: il browser si è chiuso durante il controllo';

/** Prima riga dell'errore, ripulita per i log pubblici. */
function describeCrash(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitize(message.split('\n')[0] || 'errore senza messaggio', 150);
}

function browserGone(browser: PwBrowser): boolean {
  try {
    return browser.isConnected?.() === false;
  } catch {
    return true;
  }
}

/**
 * Visita le pagine una alla volta entro deps.runBudgetMs (da `runStartedAt`, in clock()).
 * Non lancia mai: una visita che si interrompe (browser chiuso, errore imprevisto) diventa un
 * errore di quella pagina, così il riepilogo con le altre pagine viene comunque scritto.
 */
export async function runVisits(
  deps: BrowserDeps,
  visits: readonly Visit[],
  runStartedAt: number,
): Promise<VisitResult[]> {
  const deadline = runStartedAt + deps.runBudgetMs;
  const results: VisitResult[] = [];
  let slowInARow = 0;
  for (let index = 0; index < visits.length; index += 1) {
    const visit = visits[index] as Visit;
    if (deps.clock() >= deadline) {
      results.push(uncheckedVisit(visit, BUDGET_EXHAUSTED_MESSAGE));
      continue;
    }
    try {
      const result = await checkVisit(deps, visit, {
        deadline,
        allowRetry: slowInARow < MAX_SLOW_VISITS_IN_A_ROW,
      });
      results.push(result);
      slowInARow = result.timedOut ? slowInARow + 1 : 0;
    } catch (error) {
      const gone = browserGone(deps.browser);
      const reason = gone
        ? 'Il browser si è chiuso durante il controllo'
        : 'Il controllo di questa pagina si è interrotto';
      results.push(uncheckedVisit(visit, `${reason}: ${describeCrash(error)}`, 1));
      if (gone) {
        for (const rest of visits.slice(index + 1)) {
          results.push(uncheckedVisit(rest, BROWSER_GONE_MESSAGE));
        }
        break;
      }
    }
  }
  return results;
}

export function loadChromium(specifier: string): PwChromium {
  const require = createRequire(import.meta.url);
  const loaded: unknown = require(specifier);
  const chromium = isRecord(loaded) ? loaded.chromium : undefined;
  if (!isRecord(chromium) || typeof chromium.launch !== 'function') {
    throw new Error(`Il modulo "${specifier}" non espone chromium.launch (PLAYWRIGHT_CORE)`);
  }
  return chromium as unknown as PwChromium;
}

// ---------- Esecuzione ----------

/**
 * Ritorna il codice di uscita. `chromium` e `overrides` permettono ai test di passare un browser
 * finto e di sostituire attese e screenshot; la riga di comando non passa nulla.
 */
export async function main(
  env: Record<string, string | undefined> = process.env,
  chromium: PwChromium = loadChromium(env.PLAYWRIGHT_CORE?.trim() || 'playwright-core'),
  overrides: Partial<Omit<BrowserDeps, 'baseUrl' | 'browser' | 'browserVersion'>> = {},
): Promise<number> {
  const baseUrl = normalizeBaseUrl(env.BASE_URL);
  const channel = env.CHROME_CHANNEL?.trim();
  const startedAt = new Date();
  const clock = overrides.clock ?? (() => performance.now());
  const runStartedAt = clock();
  const browser = await chromium.launch(channel ? { headless: true, channel } : { headless: true });
  try {
    const browserVersion = browser.version();
    const deps: BrowserDeps = {
      baseUrl,
      browser,
      browserVersion,
      sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      clock,
      settleMs: SETTLE_MS,
      retryDelayMs: RETRY_DELAY_MS,
      navigationTimeoutMs: NAVIGATION_TIMEOUT_MS,
      visitTimeoutMs: VISIT_TIMEOUT_MS,
      runBudgetMs: RUN_BUDGET_MS,
      prepareScreenshot: async (relative) => {
        await mkdir(SCREENSHOT_DIR, { recursive: true });
        return join(process.cwd(), relative);
      },
      ...overrides,
    };
    const results = await runVisits(deps, plannedVisits(), runStartedAt);
    const summary = summarizeBrowserResults(results, {
      baseUrl,
      startedAt,
      finishedAt: new Date(),
      browserVersion,
    });
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, summary.markdown);
    process.stdout.write(summary.text);
    if (env.GITHUB_ACTIONS === 'true') process.stdout.write(renderAnnotations(results));
    return summary.exitCode;
  } finally {
    try {
      await withTimeout(browser.close(), STEP_TIMEOUT_MS, 'browser close timeout');
    } catch {
      // il browser è già chiuso
    }
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

/**
 * Esce subito dopo aver svuotato stdout e stderr: un processo di Chrome che non si chiude (o la
 * sua pipe) terrebbe vivo Node fino al timeout del job, che GitHub segnerebbe come annullato.
 */
function exitWhenFlushed(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 2_000).unref();
  process.stdout.write('', () => {
    process.stderr.write('', () => process.exit(code));
  });
}

if (isMainModule()) {
  main().then(
    (code) => {
      exitWhenFlushed(code);
    },
    async (error: unknown) => {
      process.exitCode = 2;
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
      process.stderr.write(`Controllo nel browser: lo script si è interrotto.\n${detail}\n`);
      const summary = process.env.GITHUB_STEP_SUMMARY;
      if (summary) {
        try {
          await appendFile(
            summary,
            '## Controllo nel browser — Solco\n\n**💥 Lo script si è interrotto prima di finire** ' +
              '(browser non avviato o errore imprevisto). Le pagine non sono state controllate: ' +
              'guarda il log del job per i dettagli.\n',
          );
        } catch {
          // niente riepilogo: resta il log
        }
      }
      exitWhenFlushed(2);
    },
  );
}

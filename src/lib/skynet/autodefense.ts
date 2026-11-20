// @polsia:user-owned — «Skynet», l'autodifesa (parte pura: niente rete né database). Scelta del
// proprietario: Skynet deve proteggersi da solo. Quando una delle protezioni che sorveglia viene
// SPENTA — il firewall di Vercel, il blocco gestito delle AI («AI Bots»), una regola personalizzata
// «Skynet ·» — la riaccende identica a prima, lo scrive nel diario e avvisa su Telegram.
//
// È un ripristino, non una difesa nuova:
// - riaccende SOLO ciò che ha visto acceso con i suoi occhi (`baseline`): mai una protezione che il
//   proprietario non ha mai avuto, mai una regola nata spenta;
// - non crea, non cancella e non spegne nulla; non tocca le regole senza il prefisso «Skynet ·» né
//   quelle messe a mano; una regola CANCELLATA non la può ricreare (resta l'avviso);
// - non accende la modalità attacco di Vercel («Attack Challenge Mode»): sfida ogni visitatore e
//   ferma l'app nativa e le chiamate alle API; resta una decisione del proprietario;
// - aspetta DEFENSE_CONFIRM_RUNS giri di fila prima di agire, e fra due tentativi sulla stessa
//   protezione lascia passare DEFENSE_COOLDOWN_MS;
// - se la stessa protezione viene rispenta dopo ogni ripristino («tiro alla fune») si ferma su
//   quella e lo dice: o è il proprietario che la vuole spenta, o qualcuno ha accesso a Vercel;
// - se Vercel rifiuta la modifica riprova fino a DEFENSE_MAX_FAILS volte, poi si ferma e lo dice;
// - il proprietario può metterla in pausa (al massimo 24 ore) dalla chat di Skynet, o spegnerla del
//   tutto con SKYNET_AUTODEFENSE=off.
// Se lo stato salvato manca o è corrotto si riparte da zero: l'autodifesa reimpara cosa è acceso.
import { type ProblemKey, SKYNET_RULE_PREFIX } from './signals';

/** Formato dello stato: se cambia, lo stato vecchio viene scartato. */
export const AUTODEFENSE_VERSION = 1;
export const DEFENSE_TARGETS = ['firewall', 'ai-bots', 'skynet-rules'] as const;
export type DefenseTarget = (typeof DEFENSE_TARGETS)[number];

/** Il problema di signals.ts che corrisponde a ogni protezione (per le chiavi del diario). */
export const TARGET_PROBLEM: Readonly<Record<DefenseTarget, ProblemKey>> = {
  firewall: 'firewall-off',
  'ai-bots': 'ai-bots-off',
  'skynet-rules': 'skynet-rules',
};

export const TARGET_LABEL: Readonly<Record<DefenseTarget, string>> = {
  firewall: 'il firewall di Vercel',
  'ai-bots': 'il blocco delle AI («AI Bots»)',
  'skynet-rules': 'le regole «Skynet ·»',
};

/** Giri di fila (uno al minuto) in cui la protezione deve risultare spenta prima del ripristino. */
export const DEFENSE_CONFIRM_RUNS = 2;
/** Dopo un tentativo, riuscito o no, quanto si aspetta prima di riprovare sulla stessa protezione. */
export const DEFENSE_COOLDOWN_MS = 3 * 60 * 1000;
/** Tentativi falliti di fila dopo i quali Skynet smette di provare su quella protezione. */
export const DEFENSE_MAX_FAILS = 3;
/** «Tiro alla fune»: TUG_MAX_RESTORES ripristini in questa finestra, e alla volta dopo Skynet si ferma. */
export const TUG_WINDOW_MS = 60 * 60 * 1000;
export const TUG_MAX_RESTORES = 2;
/** Una pausa più lunga di così va rinnovata: l'autodifesa non resta spenta per dimenticanza. */
export const MAX_PAUSE_MINUTES = 24 * 60;
export const DEFAULT_PAUSE_MINUTES = 120;
/** Regole riaccese al massimo in un giro (ogni regola è una chiamata a Vercel). */
export const MAX_RULES_PER_RUN = 6;
/** Regole «Skynet ·» ricordate al massimo (oggi sono 4). */
export const MAX_BASELINE_RULES = 20;

type EnvLike = Record<string, string | undefined>;
type BlockingAction = 'deny' | 'challenge';

/** L'autodifesa è accesa, a meno di SKYNET_AUTODEFENSE = 0 / off / false / no. */
export function autodefenseEnabled(env: EnvLike): boolean {
  const raw = env.SKYNET_AUTODEFENSE?.trim().toLowerCase();
  return raw !== '0' && raw !== 'off' && raw !== 'false' && raw !== 'no';
}

/** Lo stato dell'autodifesa: lo scrive solo la sentinella (SkynetState.defense). */
export type AutodefenseState = {
  v: number;
  /** Ciò che Skynet ha visto acceso: ripristina soltanto questo. */
  baseline: {
    firewall: boolean;
    /** L'azione del blocco delle AI l'ultima volta che era attivo. */
    aiBots: BlockingAction | null;
    /** Identificativi delle regole «Skynet ·» viste attive (ed esistenti all'ultima lettura). */
    rules: string[];
  };
  /** Giri di fila in cui la protezione è risultata spenta. */
  off: Partial<Record<DefenseTarget, number>>;
  /** Ripristini riusciti di recente (ISO): servono a riconoscere il tiro alla fune. */
  restores: Partial<Record<DefenseTarget, string[]>>;
  /** Ultimo tentativo (ISO), riuscito o no: per il tempo di attesa. */
  attempts: Partial<Record<DefenseTarget, string>>;
  /** Tentativi falliti di fila. */
  fails: Partial<Record<DefenseTarget, number>>;
  /** Protezioni su cui Skynet si è fermato, e da quando (ISO): qualcuno continua a spegnerle. */
  standDown: Partial<Record<DefenseTarget, string>>;
  /** L'ultimo «riprendi» del proprietario già applicato (ISO). */
  resumeSeen: string | null;
};

/**
 * Le scelte del proprietario: le scrive solo la chat di Skynet (colonne a parte, così un giro della
 * sentinella in corso non le può sovrascrivere).
 */
export type OwnerSwitch = { pausedUntil: Date | null; resumedAt: Date | null };

export const NO_OWNER_SWITCH: OwnerSwitch = { pausedUntil: null, resumedAt: null };

export function emptyAutodefense(): AutodefenseState {
  return {
    v: AUTODEFENSE_VERSION,
    baseline: { firewall: false, aiBots: null, rules: [] },
    off: {},
    restores: {},
    attempts: {},
    fails: {},
    standDown: {},
    resumeSeen: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isoOrNull(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function countOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? Math.min(value, 100_000)
    : null;
}

function isRuleId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 120;
}

/** «log» osserva soltanto: per Skynet un blocco delle AI in «log» è spento (come in readVercel). */
function blocking(action: unknown): action is BlockingAction {
  return action === 'deny' || action === 'challenge';
}

/** Lo stato salvato; qualunque cosa non valida viene scartata. */
export function parseAutodefense(raw: unknown): AutodefenseState {
  const state = emptyAutodefense();
  if (!isRecord(raw) || raw.v !== AUTODEFENSE_VERSION) return state;
  const baseline = isRecord(raw.baseline) ? raw.baseline : {};
  state.baseline.firewall = baseline.firewall === true;
  state.baseline.aiBots = blocking(baseline.aiBots) ? baseline.aiBots : null;
  state.baseline.rules = Array.isArray(baseline.rules)
    ? [...new Set(baseline.rules.filter(isRuleId))].slice(0, MAX_BASELINE_RULES)
    : [];
  state.resumeSeen = isoOrNull(raw.resumeSeen);
  const field = (name: string, target: DefenseTarget): unknown => {
    const group = raw[name];
    return isRecord(group) ? group[target] : null;
  };
  for (const target of DEFENSE_TARGETS) {
    const off = countOrNull(field('off', target));
    if (off) state.off[target] = off;
    const fails = countOrNull(field('fails', target));
    if (fails) state.fails[target] = fails;
    const restores = field('restores', target);
    if (Array.isArray(restores)) {
      const valid = restores.flatMap((at) => isoOrNull(at) ?? []).slice(-TUG_MAX_RESTORES * 2);
      if (valid.length > 0) state.restores[target] = valid;
    }
    const attempt = isoOrNull(field('attempts', target));
    if (attempt) state.attempts[target] = attempt;
    const stood = isoOrNull(field('standDown', target));
    if (stood) state.standDown[target] = stood;
  }
  return state;
}

/** Una regola personalizzata «Skynet ·» del firewall. */
export type SkynetRule = {
  id: string;
  name: string;
  active: boolean;
  /** Ciò che serve a Vercel per riaccenderla; null se la regola non si può rimandare così com'è. */
  value: Record<string, unknown> | null;
};

/** Le protezioni del firewall, come le vede l'autodifesa. */
export type FirewallView = {
  firewallEnabled: boolean | null;
  /** Il blocco gestito delle AI: attivo vuol dire acceso con «deny» o «challenge». */
  aiBots: { active: boolean; action: string | null };
  /** Le regole «Skynet ·»; null se la risposta di Vercel non ha l'elenco delle regole. */
  rules: SkynetRule[] | null;
};

/** Toglie i campi null: Vercel li restituisce ma non li accetta tutti quando la regola torna indietro. */
function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (inner !== null && inner !== undefined) out[key] = withoutNulls(inner);
  }
  return out;
}

/** La configurazione attiva del firewall (risposta di Vercel) ridotta a ciò che si può ripristinare. */
export function parseFirewallView(raw: unknown): FirewallView | null {
  if (!isRecord(raw)) return null;
  const managed = isRecord(raw.managedRules) ? raw.managedRules : {};
  const aiBots = isRecord(managed.ai_bots) ? managed.ai_bots : null;
  let rules: SkynetRule[] | null = null;
  if (Array.isArray(raw.rules)) {
    rules = [];
    for (const rule of raw.rules) {
      if (!isRecord(rule) || !isRuleId(rule.id) || typeof rule.name !== 'string') continue;
      if (!rule.name.startsWith(SKYNET_RULE_PREFIX)) continue;
      const sendable = Array.isArray(rule.conditionGroup) && isRecord(rule.action);
      rules.push({
        id: rule.id,
        name: rule.name,
        active: rule.active === true,
        value: sendable
          ? {
              name: rule.name,
              ...(typeof rule.description === 'string' ? { description: rule.description } : {}),
              active: true,
              conditionGroup: withoutNulls(rule.conditionGroup),
              action: withoutNulls(rule.action),
            }
          : null,
      });
    }
  }
  return {
    firewallEnabled: typeof raw.firewallEnabled === 'boolean' ? raw.firewallEnabled : null,
    aiBots: {
      active: aiBots?.active === true && blocking(aiBots.action),
      action: typeof aiBots?.action === 'string' ? aiBots.action : null,
    },
    rules,
  };
}

type Baseline = AutodefenseState['baseline'];

/** Aggiorna ciò che Skynet ha visto acceso con la lettura di adesso. */
export function learnBaseline(baseline: Baseline, view: FirewallView | null): Baseline {
  if (!view) return baseline;
  let rules = baseline.rules;
  if (view.rules !== null) {
    const existing = new Set(view.rules.map((rule) => rule.id));
    const active = view.rules.filter((rule) => rule.active).map((rule) => rule.id);
    // Le regole cancellate escono: Skynet non le può ricreare.
    rules = [...new Set([...baseline.rules.filter((id) => existing.has(id)), ...active])].slice(
      0,
      MAX_BASELINE_RULES,
    );
  }
  return {
    firewall: baseline.firewall || view.firewallEnabled === true,
    aiBots:
      view.aiBots.active && blocking(view.aiBots.action) ? view.aiBots.action : baseline.aiBots,
    rules,
  };
}

/** Le regole viste accese che ora sono spente (e che si possono rimandare a Vercel). */
function rulesToRestore(view: FirewallView, baseline: Baseline): SkynetRule[] {
  return (view.rules ?? []).filter(
    (rule) => !rule.active && rule.value !== null && baseline.rules.includes(rule.id),
  );
}

/** Acceso, spento (ma visto acceso: Skynet sa rimetterlo com'era), o non si sa. */
export function targetStatus(
  view: FirewallView,
  baseline: Baseline,
  target: DefenseTarget,
): 'on' | 'off' | 'unknown' {
  if (target === 'firewall') {
    if (view.firewallEnabled === null) return 'unknown';
    if (view.firewallEnabled) return 'on';
    return baseline.firewall ? 'off' : 'unknown';
  }
  if (target === 'ai-bots') {
    if (view.aiBots.active) return 'on';
    return baseline.aiBots ? 'off' : 'unknown';
  }
  if (view.rules === null) return 'unknown';
  return rulesToRestore(view, baseline).length > 0 ? 'off' : 'on';
}

export function autodefensePaused(owner: OwnerSwitch, now: Date): boolean {
  return owner.pausedUntil !== null && owner.pausedUntil.getTime() > now.getTime();
}

/**
 * Lo stato all'inizio di un giro: impara cosa è acceso, conta da quanti giri ogni protezione è
 * spenta, dimentica ripristini e tentativi vecchi, toglie fermi ed errori dalle protezioni tornate
 * accese e applica il «riprendi» del proprietario (via tutti i fermi).
 */
export function settleAutodefense(
  state: AutodefenseState,
  view: FirewallView | null,
  owner: OwnerSwitch,
  now: Date,
): AutodefenseState {
  const time = now.getTime();
  const resumed =
    owner.resumedAt && owner.resumedAt.getTime() <= time ? owner.resumedAt.toISOString() : null;
  const reset = resumed !== null && resumed !== state.resumeSeen;
  const next = emptyAutodefense();
  next.resumeSeen = resumed ?? state.resumeSeen;
  next.baseline = learnBaseline(state.baseline, view);
  for (const target of DEFENSE_TARGETS) {
    const status = view ? targetStatus(view, next.baseline, target) : 'unknown';
    // Senza lettura il conto resta com'era: un giro cieco non vale né acceso né spento.
    const off = status === 'off' ? (state.off[target] ?? 0) + 1 : (state.off[target] ?? 0);
    if (status !== 'on' && off > 0) next.off[target] = Math.min(off, 100_000);
    if (reset) continue;
    const recent = (state.restores[target] ?? []).filter(
      (at) => time - Date.parse(at) < TUG_WINDOW_MS,
    );
    if (recent.length > 0) next.restores[target] = recent;
    const attempt = state.attempts[target];
    if (attempt && time - Date.parse(attempt) < DEFENSE_COOLDOWN_MS) {
      next.attempts[target] = attempt;
    }
    if (status === 'on') continue;
    const fails = state.fails[target];
    if (fails) next.fails[target] = fails;
    const stood = state.standDown[target];
    if (stood) next.standDown[target] = stood;
  }
  return next;
}

/** Una modifica da mandare a Vercel (PATCH /v1/security/firewall/config). */
export type DefenseStep = {
  target: DefenseTarget;
  /** Come chiamarla nei messaggi: «il firewall di Vercel», «la regola «Skynet · …»». */
  label: string;
  /** Per le regole: quale. */
  ruleId: string | null;
  body: { action: string; id: string | null; value: unknown };
};

export type DefensePlan = {
  steps: DefenseStep[];
  /** Protezioni spente su cui Skynet si ferma da questo giro (tiro alla fune): da dire una volta. */
  standDown: DefenseTarget[];
  /** Perché non agisce, quando ci sarebbe da agire: spenta dal proprietario o in pausa. */
  idle: 'disabled' | 'paused' | null;
};

/** Che cosa riaccendere in questo giro. `state` deve arrivare da settleAutodefense. */
export function planAutodefense(input: {
  view: FirewallView | null;
  state: AutodefenseState;
  owner: OwnerSwitch;
  now: Date;
  enabled: boolean;
}): DefensePlan {
  const { view, state, owner, now, enabled } = input;
  const plan: DefensePlan = { steps: [], standDown: [], idle: null };
  if (!view) return plan;
  const off = DEFENSE_TARGETS.filter(
    (target) => targetStatus(view, state.baseline, target) === 'off',
  );
  if (off.length === 0) return plan;
  if (!enabled) return { ...plan, idle: 'disabled' };
  if (autodefensePaused(owner, now)) return { ...plan, idle: 'paused' };
  for (const target of off) {
    if ((state.off[target] ?? 0) < DEFENSE_CONFIRM_RUNS) continue;
    if (state.standDown[target] || state.attempts[target]) continue;
    if ((state.fails[target] ?? 0) >= DEFENSE_MAX_FAILS) continue;
    if ((state.restores[target] ?? []).length >= TUG_MAX_RESTORES) {
      plan.standDown.push(target);
      continue;
    }
    if (target === 'firewall') {
      plan.steps.push({
        target,
        label: TARGET_LABEL.firewall,
        ruleId: null,
        body: { action: 'firewallEnabled', id: null, value: true },
      });
    } else if (target === 'ai-bots') {
      plan.steps.push({
        target,
        label: TARGET_LABEL['ai-bots'],
        ruleId: null,
        body: {
          action: 'managedRules.update',
          id: 'ai_bots',
          value: { active: true, action: state.baseline.aiBots ?? 'deny' },
        },
      });
    } else {
      for (const rule of rulesToRestore(view, state.baseline).slice(0, MAX_RULES_PER_RUN)) {
        plan.steps.push({
          target,
          label: `la regola «${rule.name}»`,
          ruleId: rule.id,
          body: { action: 'rules.update', id: rule.id, value: rule.value },
        });
      }
    }
  }
  return plan;
}

/**
 * Le protezioni spente che l'autodifesa proverà a riaccendere da sola nei prossimi giri: viste
 * accese, non ferme per il tiro alla fune, non arrese dopo gli errori. (Una regola cancellata o una
 * protezione mai vista accesa non ci sono: lì resta solo l'avviso.)
 */
export function pendingRestores(
  view: FirewallView | null,
  state: AutodefenseState,
): DefenseTarget[] {
  if (!view) return [];
  return DEFENSE_TARGETS.filter(
    (target) =>
      targetStatus(view, state.baseline, target) === 'off' &&
      !state.standDown[target] &&
      (state.fails[target] ?? 0) < DEFENSE_MAX_FAILS,
  );
}

/** Dopo la modifica, riletta la configurazione: la protezione è davvero accesa? */
export function stepHolds(view: FirewallView, step: DefenseStep): boolean {
  if (step.target === 'firewall') return view.firewallEnabled === true;
  if (step.target === 'ai-bots') return view.aiBots.active;
  return (view.rules ?? []).some((rule) => rule.id === step.ruleId && rule.active);
}

export type DefenseOutcome = { step: DefenseStep; ok: boolean };

/** Lo stato dopo il giro: tentativi, ripristini ed errori segnati, fermi aggiunti. */
export function recordAutodefense(
  state: AutodefenseState,
  outcomes: DefenseOutcome[],
  standDown: DefenseTarget[],
  now: Date,
): AutodefenseState {
  const next: AutodefenseState = {
    ...state,
    off: { ...state.off },
    restores: { ...state.restores },
    attempts: { ...state.attempts },
    fails: { ...state.fails },
    standDown: { ...state.standDown },
  };
  const at = now.toISOString();
  for (const target of DEFENSE_TARGETS) {
    const mine = outcomes.filter((outcome) => outcome.step.target === target);
    if (mine.length === 0) continue;
    next.attempts[target] = at;
    if (mine.some((outcome) => outcome.ok)) {
      next.restores[target] = [...(next.restores[target] ?? []), at];
    }
    if (mine.every((outcome) => outcome.ok)) {
      delete next.fails[target];
      delete next.off[target];
    } else {
      next.fails[target] = (next.fails[target] ?? 0) + 1;
    }
  }
  for (const target of standDown) next.standDown[target] = at;
  return next;
}

function listText(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} e ${items.at(-1)}`;
}

export type DefenseEvent = {
  severity: 'critical' | 'warning' | 'info';
  title: string;
  report: string;
  keys: ProblemKey[];
};

const OWNER_HINT =
  'Se è stato lei a spegnere, me lo dica prima la prossima volta: «pausa autodifesa 2 ore» (in Amministrazione → Monitoraggio → Skynet, o /skynet su Telegram). Se non è stato lei, qualcuno ha accesso al suo Vercel: cambi la password e revochi i token che non riconosce.';

/**
 * L'evento «autodifesa» di un giro (diario e Telegram): testo fisso, niente AI. `after` è lo stato
 * già aggiornato da recordAutodefense; `verified` dice se dopo la modifica il firewall è stato
 * riletto. Un errore si dice la prima volta e quando Skynet si arrende; i tentativi in mezzo restano
 * in silenzio. Null se non c'è niente da dire.
 */
export function restoreEvent(
  outcomes: DefenseOutcome[],
  after: AutodefenseState,
  verified = true,
): DefenseEvent | null {
  const done = outcomes.filter((outcome) => outcome.ok);
  const failed = outcomes.filter((outcome) => !outcome.ok);
  const firstTry = failed.filter((outcome) => (after.fails[outcome.step.target] ?? 0) === 1);
  const gaveUp = failed.filter(
    (outcome) => (after.fails[outcome.step.target] ?? 0) >= DEFENSE_MAX_FAILS,
  );
  if (done.length === 0 && firstTry.length === 0 && gaveUp.length === 0) return null;
  const doneNames = listText(done.map((outcome) => outcome.step.label));
  const lines: string[] = [];
  if (done.length > 0) {
    const one = done.length === 1;
    const check = verified
      ? `ho riletto il firewall: ora ${one ? 'è' : 'sono'} in funzione`
      : 'Vercel ha accettato la modifica, ma non sono riuscito a rileggere il firewall per conferma';
    lines.push(
      `${one ? 'Questa protezione era spenta' : 'Queste protezioni erano spente'} da almeno ${DEFENSE_CONFIRM_RUNS} controlli di fila. ${one ? "L'ho riaccesa identica" : 'Le ho riaccese identiche'} a prima e ${check}. Non ho toccato nient'altro.`,
    );
  }
  if (firstTry.length > 0) {
    lines.push(
      `Vercel non ha accettato la modifica per ${listText(firstTry.map((outcome) => outcome.step.label))}. Riprovo da solo fra qualche minuto, altre ${DEFENSE_MAX_FAILS - 1} volte.`,
    );
  }
  if (gaveUp.length > 0) {
    lines.push(
      `Ho provato ${DEFENSE_MAX_FAILS} volte a riaccendere ${listText(gaveUp.map((outcome) => outcome.step.label))} e Vercel ha sempre rifiutato: mi fermo. Va fatto a mano da Vercel → progetto → Firewall; poi mi scriva «riprendi autodifesa».`,
    );
  }
  lines.push(OWNER_HINT);
  const shown = done.length > 0 ? done : [...firstTry, ...gaveUp];
  const targets = [...new Set(shown.map((outcome) => outcome.step.target))];
  const failedNames = listText([...firstTry, ...gaveUp].map((outcome) => outcome.step.label));
  return {
    severity: failed.some((outcome) => outcome.step.target === 'firewall') ? 'critical' : 'warning',
    title:
      done.length > 0
        ? `Autodifesa: ho riacceso ${doneNames}`
        : `Autodifesa: non riesco a riaccendere ${failedNames}`,
    report: lines.join('\n'),
    keys: targets.map((target) => TARGET_PROBLEM[target]),
  };
}

/** Evento del «tiro alla fune»: Skynet si ferma e spiega perché. */
export function standDownEvent(targets: DefenseTarget[]): DefenseEvent {
  const names = listText(targets.map((target) => TARGET_LABEL[target]));
  return {
    severity: targets.includes('firewall') ? 'critical' : 'warning',
    title: `Autodifesa ferma: qualcuno continua a spegnere ${names}`,
    report: [
      `Nell'ultima ora ho riacceso ${names} ${TUG_MAX_RESTORES} volte e ogni volta qualcuno ha rispento. Mi fermo, per non contrastare una sua scelta.`,
      'Se è lei, non serve altro: riprendo da solo quando la protezione torna accesa, oppure mi scriva «riprendi autodifesa».',
      'Se non è lei, qualcuno ha accesso al suo Vercel: cambi subito la password, revochi tutti i token e riaccenda la protezione da Vercel → progetto → Firewall.',
    ].join('\n'),
    keys: targets.map((target) => TARGET_PROBLEM[target]),
  };
}

const ROME_PARTS = new Intl.DateTimeFormat('it-IT', {
  timeZone: 'Europe/Rome',
  day: 'numeric',
  month: 'long',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** «20 novembre alle 14:05», ora italiana. */
export function romeTime(date: Date): string {
  const parts: Record<string, string> = {};
  for (const part of ROME_PARTS.formatToParts(date)) parts[part.type] = part.value;
  return `${parts.day} ${parts.month} alle ${parts.hour}:${parts.minute}`;
}

/** Fino a quando dura una pausa di `minutes` (da 1 a MAX_PAUSE_MINUTES). */
export function pauseUntil(minutes: number, now: Date): Date {
  const clamped = Math.min(
    MAX_PAUSE_MINUTES,
    Math.max(1, Math.round(Number.isFinite(minutes) ? minutes : DEFAULT_PAUSE_MINUTES)),
  );
  return new Date(now.getTime() + clamped * 60_000);
}

/** Da dove arriva il comando del proprietario: si legge nel diario. */
export type OwnerSource = 'pannello' | 'telegram';

export function pauseEvent(until: Date, source: OwnerSource): DefenseEvent {
  return {
    severity: 'warning',
    title: `Autodifesa in pausa fino al ${romeTime(until)}`,
    report: [
      `Richiesta ${source === 'telegram' ? 'da Telegram' : 'dal pannello di amministrazione'}. Fino ad allora non riaccendo le protezioni che trovo spente; controlli e avvisi continuano come sempre.`,
      'Per riprendere prima: «riprendi autodifesa».',
      'Se non è stato lei a chiederlo, qualcuno usa il suo account: cambi la password e chiuda le altre sessioni.',
    ].join('\n'),
    keys: [],
  };
}

export function resumeEvent(source: OwnerSource): DefenseEvent {
  return {
    severity: 'info',
    title: 'Autodifesa ripresa',
    report: `Richiesta ${source === 'telegram' ? 'da Telegram' : 'dal pannello di amministrazione'}. Torno a riaccendere da solo il firewall, il blocco delle AI e le regole «Skynet ·» quando li trovo spenti; ho azzerato fermi e tentativi.`,
    keys: [],
  };
}

/** Quello che pannello e chat mostrano dell'autodifesa. */
export type AutodefenseSummary = {
  mode: 'active' | 'paused' | 'disabled';
  pausedUntil: string | null;
  /** Protezioni che Skynet ha visto accese e quindi sa riaccendere. */
  watching: { firewall: boolean; aiBots: boolean; rules: number };
  /** Protezioni su cui si è fermata perché qualcuno continua a spegnerle. */
  standDown: DefenseTarget[];
  /** Protezioni che non è riuscita a riaccendere (Vercel ha rifiutato). */
  failing: DefenseTarget[];
  /** Ripristini riusciti nell'ultima ora. */
  restoredLastHour: number;
};

export function autodefenseSummary(
  state: AutodefenseState,
  owner: OwnerSwitch,
  now: Date,
  enabled: boolean,
): AutodefenseSummary {
  const paused = autodefensePaused(owner, now);
  const time = now.getTime();
  return {
    mode: !enabled ? 'disabled' : paused ? 'paused' : 'active',
    pausedUntil: paused && owner.pausedUntil ? owner.pausedUntil.toISOString() : null,
    watching: {
      firewall: state.baseline.firewall,
      aiBots: state.baseline.aiBots !== null,
      rules: state.baseline.rules.length,
    },
    standDown: DEFENSE_TARGETS.filter((target) => state.standDown[target]),
    failing: DEFENSE_TARGETS.filter((target) => (state.fails[target] ?? 0) >= DEFENSE_MAX_FAILS),
    restoredLastHour: DEFENSE_TARGETS.reduce(
      (total, target) =>
        total +
        (state.restores[target] ?? []).filter((at) => time - Date.parse(at) < TUG_WINDOW_MS).length,
      0,
    ),
  };
}

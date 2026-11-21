// @polsia:user-owned — 4 specialist agents + 1 lead review the PERFORMANCE of Solco's yt-dlp worker
// (workers/ytdlp-worker, a FastAPI service on Render). They read the worker's own source code
// (functions extracted by name, never secrets: the repo holds none) and its live public /health.
import { readFile } from 'node:fs/promises';
import { timedGet } from './lib.mjs';

export const WORKER_HEALTH_URL = 'https://s2a76b51c9520ac.onrender.com/health';

export const WORKER_SUBJECT =
  'Sei un ingegnere backend Python esperto di prestazioni e revisioni il worker yt-dlp di Solco: ' +
  'FastAPI + yt-dlp + ffmpeg su Render, piano free (0,1 CPU, 512 MB di RAM, si addormenta e ha ' +
  'avvii a freddo). Il bot Telegram di Solco aspetta al più 40 s una risposta di POST /download. ' +
  'YouTube blocca l’IP del worker («Sign in to confirm you’re not a bot»): passa solo uscendo da ' +
  'Cloudflare WARP (client usque in modalità proxy). Per ogni proposta indica la FUNZIONE coinvolta, ' +
  'il guadagno atteso (tempo, memoria o affidabilità), il rischio e il cambio concreto. Non proporre ' +
  'di indebolire autenticazione, firme dei link o limiti di sicurezza.';

/**
 * Top-level blocks of a Python module by name (def / async def / class, decorators included), up
 * to the next top-level statement. `'__header__'` is everything before the first def/class
 * (imports and configuration).
 */
export function extractPython(source, names) {
  const lines = source.split('\n');
  const starts = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^(?:async\s+def|def|class)\s+([A-Za-z_]\w*)/);
    if (!m) continue;
    let start = i;
    while (start > 0 && /^@/.test(lines[start - 1])) start -= 1; // decorators belong to the block
    starts.push({ name: m[1], start, def: i });
  }
  const blocks = [];
  for (const name of names) {
    if (name === '__header__') {
      const end = starts[0]?.start ?? lines.length;
      blocks.push(lines.slice(0, end).join('\n'));
      continue;
    }
    const at = starts.findIndex((s) => s.name === name);
    if (at < 0) continue;
    let end = lines.length;
    for (let j = starts[at].def + 1; j < lines.length; j += 1) {
      if (/^\S/.test(lines[j]) && !/^#/.test(lines[j])) {
        end = j;
        break;
      }
    }
    blocks.push(lines.slice(starts[at].start, end).join('\n').trimEnd());
  }
  return blocks.join('\n\n');
}

/** The 4 specialists: each sees only its functions (+ the live state when it matters). */
export const WORKER_SPECIALISTS = [
  {
    id: 'pipeline',
    title: 'Pipeline di download e opzioni yt-dlp',
    facts: (m) =>
      `requirements.txt:\n${m.files.requirements}\n\napp.py:\n` +
      extractPython(m.files.app, ['_base_opts', '_target', '_pick_entry', 'download', '_extract_url', '_serve_download']),
  },
  {
    id: 'antibot',
    title: 'Scala anti-bot e uscita WARP (tempo entro i 40 s del bot)',
    facts: (m) =>
      `Stato dal vivo (/health → antibot): ${JSON.stringify(m.health?.antibot ?? null)}\n\napp.py:\n` +
      extractPython(m.files.app, ['_client_plan', '_first_exit', '_wait_for_warp', '_note_outcome', '_run_with_antibot', 'WarpExit']),
  },
  {
    id: 'serve-memory',
    title: 'Modalità serve: file, pulizia, memoria e disco',
    facts: (m) =>
      'app.py:\n' +
      extractPython(m.files.app, ['__header__', '_sign', '_signed_path', '_sweep', '_cleanup_loop', '_serve_download', 'serve_file']),
  },
  {
    id: 'startup',
    title: 'Avvio a freddo, immagine Docker e strato HTTP',
    facts: (m) =>
      `Misura dal vivo di /health: ${JSON.stringify(m.healthTiming)}\n\nDockerfile:\n${m.files.dockerfile}\n\n` +
      `render.yaml (servizio del worker):\n${m.files.render}\n\napp.py:\n` +
      extractPython(m.files.app, ['lifespan', 'health', 'antibot', '_check_auth']),
  },
];

/** Reads the worker's files and its live /health (public, no key). */
export async function collectWorker({ root, fetchImpl = fetch, healthUrl = WORKER_HEALTH_URL } = {}) {
  const read = (path) => readFile(new URL(path, root), 'utf8').catch(() => '(file non trovato)');
  const [app, dockerfile, requirements, renderYaml] = await Promise.all([
    read('workers/ytdlp-worker/app.py'),
    read('workers/ytdlp-worker/Dockerfile'),
    read('workers/ytdlp-worker/requirements.txt'),
    read('render.yaml'),
  ]);
  // Only the worker's service from render.yaml (the agents' cron job is not their business).
  const render = renderYaml.split(/\n(?=\s{2}# ── )/)[0];
  const health = await timedGet(healthUrl, fetchImpl, 90_000); // a free Render service may be asleep
  let parsed = null;
  try {
    parsed = JSON.parse(health.body ?? '');
  } catch {
    parsed = null;
  }
  return {
    measuredAt: new Date().toISOString(),
    files: { app, dockerfile, requirements, render },
    health: parsed,
    healthTiming: { status: health.status, ttfbMs: health.ttfbMs, totalMs: health.totalMs, error: health.error },
  };
}

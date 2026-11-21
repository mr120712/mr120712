#!/usr/bin/env node
// @polsia:user-owned — Solco AI performance review, run by a Render Cron Job (no public port).
// Measures the live site, runs 7 specialist agents + 1 lead agent (MWAPI key 1 and key 2 first,
// then your private FreeLLMAPI, then Solco's reserve) and prints the report; optionally sends it to
// Telegram. Exit codes: 0 report produced · 1 configuration refused · 2 no AI backend answered.
import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import {
  backendsFrom,
  chat,
  chunks,
  measure,
  redact,
  renderReport,
  resolveAutoModels,
  runReview,
} from './lib.mjs';
import { AD_LEAD_PROMPT, AD_SPECIALISTS, AD_SYSTEM, collectAdFacts, parseStoryboard } from './tiktok-ad.mjs';
import { collectWorker, WORKER_SPECIALISTS, WORKER_SUBJECT } from './worker-review.mjs';

const env = process.env;
const secrets = [
  env.MAGNETAPI_API_KEY,
  env.MWAPI_API_KEY,
  env.MWAPI_API_KEY_2,
  env.FREELLMAPI_PRIVATE_KEY,
  env.SOLCO_RESERVE_KEY,
  env.FREELLMAPI_API_KEY,
  env.FREELLMAPI_TOKEN,
  env.TELEGRAM_BOT_TOKEN,
].filter(Boolean);
const log = (...parts) => console.log(redact(parts.join(' '), secrets));

async function sendTelegram(text) {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chat = env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chat) return;
  for (const part of chunks(text)) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: part, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(20_000),
    }).catch((error) => ({ ok: false, status: error?.name }));
    if (!res.ok) log(`telegram: invio non riuscito (${res.status})`);
  }
}

async function main() {
  let backends;
  try {
    const config = backendsFrom(env);
    backends = config.backends;
    for (const warning of config.warnings) log(`config: ${warning}`);
  } catch (error) {
    log(`config: ${error.message}`);
    return 1;
  }
  // «models»: only list what each key unlocks (models-only check, nothing measured, no agent runs).
  const listOnly = env.REVIEW_TARGET?.trim() === 'models';
  const resolved = await resolveAutoModels(
    listOnly ? backends.map((b) => (b.name === 'magnetapi' || b.name.startsWith('mwapi') ? { ...b, model: 'auto' } : b)) : backends,
  );
  for (const note of resolved.notes) log(`modelli: ${note}`);
  if (listOnly) {
    // A tiny real request per model (5 tokens): listed is not the same as answering.
    let answering = 0;
    for (const backend of resolved.backends) {
      const started = Date.now();
      try {
        const { text } = await chat([{ role: 'user', content: 'Rispondi solo: ok' }], [backend], { attempts: 1, maxTokens: 5, timeoutMs: 45_000 });
        answering += 1;
        log(`prova: ${backend.name} ${backend.model} ✅ risponde in ${Date.now() - started} ms («${text.slice(0, 20)}»)`);
      } catch (error) {
        log(`prova: ${backend.name} ${backend.model} ❌ ${error.message.replace(/^all AI backends failed /, '')}`);
      }
    }
    return answering > 0 ? 0 : 2;
  }
  backends = resolved.backends;
  if (backends.length === 0) {
    log('config: nessun backend con un modello utilizzabile');
    return 2;
  }
  log(`backend: ${backends.map((b) => `${b.name} (${b.model})`).join(' → ')}`);

  // REVIEW_TARGET: «site» (default, 7 agents on the live site) or «ytdlp-worker» (4 agents on the
  // worker's code and live /health).
  const target = env.REVIEW_TARGET?.trim() || 'site';
  const common = { concurrency: Number(env.AGENT_CONCURRENCY) || 2, language: env.REPORT_LANGUAGE?.trim() || 'italiano' };
  let measurements;
  let options;
  let title;
  if (target === 'ytdlp-worker') {
    measurements = await collectWorker({ root: new URL('../../', import.meta.url) });
    log(`misure: worker /health ${measurements.healthTiming.status ?? measurements.healthTiming.error} in ${measurements.healthTiming.totalMs} ms, app.py ${measurements.files.app.length} caratteri`);
    options = { ...common, specialists: WORKER_SPECIALISTS, subject: WORKER_SUBJECT, clipChars: 24_000, maxTokens: 1400 };
    title = 'Worker yt-dlp — revisione prestazioni';
  } else if (target === 'tiktok-ad') {
    measurements = await collectAdFacts({ root: new URL('../../', import.meta.url) });
    log(`fatti: ${measurements.facts.sections.length} sezioni, ${Object.keys(measurements.screens).length} schermi, Pro in vendita: ${measurements.facts.proOnSale}`);
    options = { ...common, specialists: AD_SPECIALISTS, system: AD_SYSTEM, leadPrompt: AD_LEAD_PROMPT, clipChars: 12_000, maxTokens: 1400, leadMaxTokens: 2200 };
    title = 'Solco — spot TikTok';
  } else if (target === 'site') {
    const pages = env.REVIEW_PAGES?.split(',').map((p) => p.trim()).filter((p) => p.startsWith('/'));
    measurements = await measure({ ...(pages?.length ? { pages } : {}) });
    log(`misure: ${measurements.pages.length} pagine, ${measurements.assets.length} file JS/CSS, ${measurements.apis.length} API`);
    options = common;
    title = 'Solco — revisione prestazioni';
  } else {
    log(`config: REVIEW_TARGET sconosciuto (${target}): usa site, ytdlp-worker, tiktok-ad o models`);
    return 1;
  }

  let review;
  try {
    review = await runReview(measurements, backends, options);
  } catch (error) {
    log(`agenti: ${error.message}`);
    return 2;
  }
  const report = renderReport(measurements, review, title);
  log(report);
  // The ad's storyboard, validated, as a separate file the renderer reads (STORYBOARD_FILE).
  if (target === 'tiktok-ad') {
    try {
      const storyboard = parseStoryboard(review.lead.text);
      log(`storyboard: ${storyboard.scenes.length} scene, ${storyboard.durationSeconds} s`);
      log(`STORYBOARD_JSON ${JSON.stringify(storyboard)}`);
      if (env.STORYBOARD_FILE?.trim()) await writeFile(env.STORYBOARD_FILE.trim(), `${JSON.stringify(storyboard, null, 2)}\n`);
    } catch (error) {
      log(error.message);
      return 2;
    }
  }
  // GitHub Actions / other runners: also write the report to a file (REPORT_FILE), already redacted.
  if (env.REPORT_FILE?.trim()) await writeFile(env.REPORT_FILE.trim(), `${redact(report, secrets)}\n`);
  await sendTelegram(report);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    log(`errore inatteso: ${error?.message ?? error}`);
    process.exit(2);
  },
);

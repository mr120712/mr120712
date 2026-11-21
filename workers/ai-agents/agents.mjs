#!/usr/bin/env node
// @polsia:user-owned — Solco AI performance review, run by a Render Cron Job (no public port).
// Measures the live site, runs 7 specialist agents + 1 lead agent (MWAPI key 1 and key 2 first,
// then your private FreeLLMAPI, then Solco's reserve) and prints the report; optionally sends it to
// Telegram. Exit codes: 0 report produced · 1 configuration refused · 2 no AI backend answered.
import process from 'node:process';
import { backendsFrom, chunks, measure, redact, renderReport, runReview } from './lib.mjs';

const env = process.env;
const secrets = [
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
  log(`backend: ${backends.map((b) => b.name).join(' → ')}`);

  const pages = env.REVIEW_PAGES?.split(',').map((p) => p.trim()).filter((p) => p.startsWith('/'));
  const measurements = await measure({ ...(pages?.length ? { pages } : {}) });
  log(`misure: ${measurements.pages.length} pagine, ${measurements.assets.length} file JS/CSS, ${measurements.apis.length} API`);

  let review;
  try {
    review = await runReview(measurements, backends, {
      concurrency: Number(env.AGENT_CONCURRENCY) || 3,
      language: env.REPORT_LANGUAGE?.trim() || 'italiano',
    });
  } catch (error) {
    log(`agenti: ${error.message}`);
    return 2;
  }
  const report = renderReport(measurements, review);
  log(report);
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

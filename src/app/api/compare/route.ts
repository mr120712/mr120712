// @polsia:user-owned — proxy OpenAI-compatible verso TRE backend:
//   • modello "artex" (o "artex:<agent_key>") → askArtex() sul VPS,
//     convertito in stream SSE OpenAI-compatible (delta.content
//     incrementale a partire dagli onProgress di ARTEX)
//   • "freellmapi" (o "freellmapi:<model>") → riserva AI pubblica di Solco
//     (www.solcomusic.online/api/ai-reserve/v1). Non streama: la route
//     avvolge la risposta JSON in un singolo delta SSE finto
//   • qualsiasi altro id → gateway LOCAL_LLM_BASE_URL (OpenAI-compatible),
//     relay diretto della SSE con stream_options.include_usage
//
// Una chiamata = un modello. Il client fa fan-out di N richieste parallele a
// questa route, così le risposte compaiono una a una.
//
// Variabili d'ambiente richieste (in .env.local):
//   LOCAL_LLM_BASE_URL   es. http://192.168.0.117:8080 (gateway OpenAI)
//   LOCAL_LLM_KEY        bearer token del gateway
//   ARTEX_URL            es. https://artex.solcomusic.online (solo per modello "artex*")
//   ARTEX_PASSWORD       password login JWT su ARTEX
//   ARTEX_USERNAME       facoltativo (default: ARTEX)
//   ARTEX_CHAT_AGENT_KEY facoltativo (default: 'auto')
//   FREELLMAPI_API_KEY   bearer della riserva Solco (solo per "freellmapi*");
//                         fallback: FREELLMAPI_TOKEN
//   FREELLMAPI_BASE_URL  facoltativo; default https://www.solcomusic.online/api/ai-reserve/v1

import 'server-only';
import { NextResponse } from 'next/server';
import { artexConfig, askArtex } from '@/lib/business/artex-client.server';
import { CompareRequest, type CompareResult } from '@/lib/contracts/compare';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Finestra di tolleranza oltre il nostro timeout (vedi UPSTREAM_TIMEOUT_MS).
export const maxDuration = 120;

const UPSTREAM_TIMEOUT_MS = 90_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readConfig(): { baseUrl: string; apiKey: string } | { error: string } {
  const baseUrl = process.env.LOCAL_LLM_BASE_URL?.trim();
  const apiKey = process.env.LOCAL_LLM_KEY?.trim();
  if (!baseUrl) return { error: 'LOCAL_LLM_BASE_URL non impostata (.env.local).' };
  if (!apiKey) return { error: 'LOCAL_LLM_KEY non impostata (.env.local).' };
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey };
}

export async function POST(req: Request) {
  if (!sameOrigin(req)) {
    return NextResponse.json({ error: 'forbidden_origin' }, { status: 403 });
  }

  const parsed = CompareRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const fieldErrors = parsed.error.flatten().fieldErrors;
    const errors: Record<string, string> = {};
    for (const [field, messages] of Object.entries(fieldErrors)) {
      const message = messages?.[0];
      if (message) errors[field] = message;
    }
    return NextResponse.json({ errors }, { status: 400 });
  }

  const { model, prompt, temperature, maxTokens } = parsed.data;
  const started = Date.now();

  // --- Branch ARTEX ENSEMBLE (7 agent in parallelo + giudice FreeLLMAPI) --
  // Deve stare PRIMA del branch generico "artex:*" altrimenti "ensemble"
  // viene scambiato per un agent_key letterale e passato tale a ARTEX.
  if (model === 'artex:ensemble') {
    const config = artexConfig();
    if (!config) {
      return NextResponse.json(
        { error: 'ARTEX_URL / ARTEX_PASSWORD non impostate (.env.local).' },
        { status: 500 },
      );
    }
    const judgeKey = (process.env.FREELLMAPI_API_KEY ?? process.env.FREELLMAPI_TOKEN)?.trim();
    if (!judgeKey) {
      return NextResponse.json(
        { error: 'FREELLMAPI_API_KEY non impostata: serve per il giudice.' },
        { status: 500 },
      );
    }
    const judgeBaseUrl = (
      process.env.FREELLMAPI_BASE_URL?.trim() || 'https://www.solcomusic.online/api/ai-reserve/v1'
    ).replace(/\/+$/, '');

    // 7 agent ARTEX. Escluso `worker` (executor di intenti, risposte sintetiche
    // o vuote per domande libere). Tutti gli altri rispondono a prompt arbitrari.
    const AGENTS = [
      'goals',
      'planner',
      'mainagent',
      'auto',
      'pentest',
      'reporter',
      'retester',
    ] as const;

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let closed = false;
        const emit = (obj: unknown) => {
          if (closed) return;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        };
        const abortOnClient = () => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            /* ignore */
          }
        };
        req.signal.addEventListener('abort', abortOnClient);

        try {
          emit({
            id: `artex-ensemble-${Date.now()}`,
            model: 'artex/ensemble',
            choices: [{ index: 0, delta: { role: 'assistant' } }],
          });

          // Fan-out: ogni agent crea la propria conversation + polling. Timeout
          // 80s per agent sta sotto il maxDuration della route (120s) con margine
          // per il giudice.
          const results = await Promise.allSettled(
            AGENTS.map((agentKey) =>
              askArtex(prompt, process.env, fetch, {
                agentKey,
                timeoutMs: 80_000,
                pollIntervalMs: 1_500,
              }),
            ),
          );

          const voices: Array<{ agent: string; text: string; conv?: number }> = [];
          const failures: string[] = [];
          for (let i = 0; i < AGENTS.length; i++) {
            const agent = AGENTS[i];
            const r = results[i];
            if (!agent || !r) continue;
            if (r.status === 'fulfilled') {
              if (r.value.status === 'ok' && r.value.reply) {
                voices.push({ agent, text: r.value.reply, conv: r.value.conversationId });
              } else if (r.value.status === 'not_configured') {
                failures.push(`${agent}: not_configured`);
              } else if (r.value.status === 'failed') {
                const detail = r.value.detail ? ` — ${r.value.detail}` : '';
                failures.push(`${agent}: ${r.value.error}${detail}`);
              }
            } else {
              const reason = r.reason instanceof Error ? r.reason.message : 'unknown';
              failures.push(`${agent}: ${reason}`);
            }
          }

          if (voices.length === 0) {
            emit({
              choices: [
                {
                  index: 0,
                  delta: {
                    content: `\n\n❌ Nessun agent ARTEX ha risposto:\n${failures.join('\n')}`,
                  },
                  finish_reason: 'error',
                },
              ],
            });
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            return;
          }

          // Giudice FreeLLMAPI (gpt-oss-120b): consolida le voci.
          const judgePrompt = [
            `Un utente ha chiesto:\n"""\n${prompt}\n"""`,
            '',
            `${voices.length} agent di una piattaforma pentest hanno risposto. Scrivi la MIGLIORE risposta sintetizzando il meglio di ciascuna: correggi errori, unisci dettagli utili, scarta ridondanze e riferimenti interni alla piattaforma. Rispondi direttamente all'utente nella sua lingua, senza menzionare agent o procedura.`,
            '',
            ...voices.map((v) => `## Risposta ${v.agent}\n${v.text}`),
          ].join('\n');

          let judgeText: string;
          try {
            const judgeRes = await fetch(`${judgeBaseUrl}/chat/completions`, {
              method: 'POST',
              headers: {
                authorization: `Bearer ${judgeKey}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify({
                model: 'openai/gpt-oss-120b',
                messages: [{ role: 'user', content: judgePrompt }],
                stream: false,
                temperature: 0.2,
                ...(typeof maxTokens === 'number' ? { max_tokens: maxTokens } : {}),
              }),
              cache: 'no-store',
              signal: req.signal,
            });
            if (!judgeRes.ok) throw new Error(`HTTP ${judgeRes.status}`);
            const judgeBody: unknown = await judgeRes.json();
            const judgeObj = isRecord(judgeBody) ? judgeBody : {};
            const judgeChoices = Array.isArray(judgeObj.choices) ? judgeObj.choices : [];
            const judgeChoice = isRecord(judgeChoices[0]) ? judgeChoices[0] : null;
            const judgeMessage =
              judgeChoice && isRecord(judgeChoice.message) ? judgeChoice.message : null;
            judgeText =
              typeof judgeMessage?.content === 'string' ? judgeMessage.content.trim() : '';
            if (!judgeText) throw new Error('giudice ha restituito contenuto vuoto');
          } catch (err) {
            // Fallback: consegna la voce più lunga (euristica: più informativa).
            const fallback = [...voices].sort((a, b) => b.text.length - a.text.length)[0];
            const detail = err instanceof Error ? err.message : 'unknown';
            emit({
              model: `artex/ensemble (judge failed: ${detail})`,
              choices: [
                {
                  index: 0,
                  delta: { content: fallback ? fallback.text : '' },
                  finish_reason: 'stop',
                },
              ],
            });
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            return;
          }

          emit({
            model: `artex/ensemble (${voices.length}/${AGENTS.length} + judge)`,
            choices: [
              {
                index: 0,
                delta: { content: judgeText },
                finish_reason: 'stop',
              },
            ],
            ...(failures.length > 0 ? { x_artex_failures: failures } : {}),
          });
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        } catch (err) {
          if (closed) return;
          const message = err instanceof Error ? err.message : 'unknown_error';
          emit({
            choices: [
              {
                index: 0,
                delta: { content: `\n\n❌ ensemble error: ${message}` },
                finish_reason: 'error',
              },
            ],
          });
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        } finally {
          req.signal.removeEventListener('abort', abortOnClient);
          if (!closed) {
            closed = true;
            try {
              controller.close();
            } catch {
              /* ignore */
            }
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    });
  }

  // --- Branch ARTEX -------------------------------------------------------
  if (model === 'artex' || model.startsWith('artex:')) {
    const config = artexConfig();
    if (!config) {
      return NextResponse.json(
        { error: 'ARTEX_URL / ARTEX_PASSWORD non impostate (.env.local).' },
        { status: 500 },
      );
    }
    const agentKey = model.startsWith('artex:')
      ? model.slice('artex:'.length) || undefined
      : undefined;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let lastEmitted = '';
        let closed = false;
        const emit = (obj: unknown) => {
          if (closed) return;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        };

        // Primo chunk con il "resolved model" così la card mostra già una badge
        // sensata prima che arrivi il primo token.
        emit({
          id: `artex-${Date.now()}`,
          model: `artex/${agentKey ?? 'auto'}`,
          choices: [{ index: 0, delta: { role: 'assistant' } }],
        });

        const abortOnClient = () => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        req.signal.addEventListener('abort', abortOnClient);

        try {
          const outcome = await askArtex(prompt, process.env, fetch, {
            agentKey,
            timeoutMs: 110_000,
            pollIntervalMs: 1_000,
            onProgress: (partial) => {
              if (closed || !partial) return;
              // askArtex consegna il TESTO INTERO visto finora, non un diff.
              // Se è un prefisso di lastEmitted (prefisso stabile) emettiamo
              // solo la coda nuova; altrimenti emetti tutto il nuovo testo:
              // il client lo concatenerà e vedrà un salto, ma restiamo
              // compatibili col contratto OpenAI delta.
              let chunk: string;
              if (partial.startsWith(lastEmitted)) {
                chunk = partial.slice(lastEmitted.length);
                if (!chunk) return;
              } else {
                chunk = partial;
              }
              lastEmitted = partial;
              emit({ choices: [{ index: 0, delta: { content: chunk } }] });
            },
          });

          if (closed) return;
          if (outcome.status === 'ok') {
            // Chiudi bene: se askArtex ha consegnato la reply solo nel return
            // (non via onProgress), aggiungi la coda mancante.
            if (
              outcome.reply.length > lastEmitted.length &&
              outcome.reply.startsWith(lastEmitted)
            ) {
              emit({
                choices: [
                  { index: 0, delta: { content: outcome.reply.slice(lastEmitted.length) } },
                ],
              });
            }
            emit({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
          } else if (outcome.status === 'not_configured') {
            emit({
              choices: [
                {
                  index: 0,
                  delta: { content: '\n\n❌ ARTEX non configurato.' },
                  finish_reason: 'error',
                },
              ],
            });
          } else {
            const detail = outcome.detail ? ` — ${outcome.detail}` : '';
            emit({
              choices: [
                {
                  index: 0,
                  delta: { content: `\n\n❌ ARTEX ${outcome.error}${detail}` },
                  finish_reason: 'error',
                },
              ],
            });
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        } catch (err) {
          if (closed) return;
          const message = err instanceof Error ? err.message : 'unknown_error';
          emit({
            choices: [
              {
                index: 0,
                delta: { content: `\n\n❌ ${message}` },
                finish_reason: 'error',
              },
            ],
          });
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        } finally {
          req.signal.removeEventListener('abort', abortOnClient);
          if (!closed) {
            closed = true;
            try {
              controller.close();
            } catch {
              /* ignore */
            }
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    });
  }

  // --- Branch FreeLLMAPI ENSEMBLE (4 modelli in parallelo + giudice) ------
  // Deve stare PRIMA del branch generico "freellmapi:*" così non viene
  // scambiato per un passthrough con model="ensemble".
  if (model === 'freellmapi:ensemble') {
    const apiKey = (process.env.FREELLMAPI_API_KEY ?? process.env.FREELLMAPI_TOKEN)?.trim();
    if (!apiKey) {
      return NextResponse.json(
        { error: 'FREELLMAPI_API_KEY non impostata (.env.local).' },
        { status: 500 },
      );
    }
    const baseUrl = (
      process.env.FREELLMAPI_BASE_URL?.trim() || 'https://www.solcomusic.online/api/ai-reserve/v1'
    ).replace(/\/+$/, '');

    // 4 membri del pool: due taglie di gpt-oss (Groq) a temperature diverse
    // per avere varietà "stabile" + due auto, che Solco ruota in fallback. Se
    // uno fallisce (404/429/5xx) il giudice lavora con i restanti; se falliscono
    // tutti, si torna al client con un errore chiaro.
    const members: Array<{ label: string; model: string; temperature: number }> = [
      { label: 'A', model: 'openai/gpt-oss-120b', temperature: 0.2 },
      { label: 'B', model: 'openai/gpt-oss-120b', temperature: 0.7 },
      { label: 'C', model: 'openai/gpt-oss-20b', temperature: 0.3 },
      { label: 'D', model: 'auto', temperature: 0.5 },
    ];
    const JUDGE_MODEL = 'openai/gpt-oss-120b';
    const encoder = new TextEncoder();

    const callOne = async (
      upstreamModel: string,
      temperatureOverride: number,
      userPrompt: string,
    ) => {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: upstreamModel,
          messages: [{ role: 'user', content: userPrompt }],
          stream: false,
          temperature: typeof temperature === 'number' ? temperature : temperatureOverride,
          ...(typeof maxTokens === 'number' ? { max_tokens: maxTokens } : {}),
        }),
        cache: 'no-store',
        signal: req.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body: unknown = await res.json();
      const bodyObj = isRecord(body) ? body : {};
      const choices = Array.isArray(bodyObj.choices) ? bodyObj.choices : [];
      const choice = isRecord(choices[0]) ? choices[0] : null;
      const message = choice && isRecord(choice.message) ? choice.message : null;
      const content = typeof message?.content === 'string' ? message.content : '';
      return content.trim();
    };

    const stream = new ReadableStream({
      async start(controller) {
        let closed = false;
        const emit = (obj: unknown) => {
          if (closed) return;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        };
        const abortOnClient = () => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            /* ignore */
          }
        };
        req.signal.addEventListener('abort', abortOnClient);

        try {
          emit({
            id: `freellmapi-ensemble-${Date.now()}`,
            model: 'freellmapi/ensemble',
            choices: [{ index: 0, delta: { role: 'assistant' } }],
          });

          const results = await Promise.allSettled(
            members.map((m) => callOne(m.model, m.temperature, prompt)),
          );
          const voices: Array<{ label: string; model: string; text: string }> = [];
          const failures: string[] = [];
          results.forEach((r, i) => {
            const m = members[i];
            if (!m) return;
            if (r.status === 'fulfilled' && r.value) {
              voices.push({ label: m.label, model: m.model, text: r.value });
            } else {
              const reason =
                r.status === 'rejected'
                  ? r.reason instanceof Error
                    ? r.reason.message
                    : 'unknown'
                  : 'empty';
              failures.push(`${m.label} (${m.model}): ${reason}`);
            }
          });

          if (voices.length === 0) {
            emit({
              choices: [
                {
                  index: 0,
                  delta: {
                    content: `\n\n❌ Nessun modello del pool ha risposto:\n${failures.join('\n')}`,
                  },
                  finish_reason: 'error',
                },
              ],
            });
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            return;
          }

          // Giudice: una sola chiamata che riceve tutte le voci etichettate e
          // deve produrre la MIGLIORE risposta (non parafrasi). Teniamo il
          // prompt breve e cite-friendly così non sfora.
          const judgePrompt = [
            `Un utente ha chiesto:\n"""\n${prompt}\n"""`,
            '',
            `${voices.length} modelli hanno risposto. Scrivi la MIGLIORE risposta sintetizzando il meglio di ciascuna: correggi errori, unisci dettagli utili, scarta ridondanze. Rispondi direttamente all'utente nella sua lingua, senza menzionare i modelli o la procedura.`,
            '',
            ...voices.map((v) => `## Risposta ${v.label} (${v.model})\n${v.text}`),
          ].join('\n');

          let judgeText: string;
          try {
            judgeText = await callOne(JUDGE_MODEL, 0.2, judgePrompt);
          } catch (err) {
            // Se anche il giudice fallisce, consegna la risposta A come fallback
            // (è la prima voce disponibile, quasi sempre gpt-oss-120b stabile).
            const fallback = voices[0];
            const detail = err instanceof Error ? err.message : 'unknown';
            emit({
              model: `freellmapi/ensemble (judge failed: ${detail})`,
              choices: [
                {
                  index: 0,
                  delta: { content: fallback ? fallback.text : '' },
                  finish_reason: 'stop',
                },
              ],
            });
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            return;
          }

          emit({
            model: `freellmapi/ensemble (${voices.length}/${members.length} + judge)`,
            choices: [
              {
                index: 0,
                delta: { content: judgeText },
                finish_reason: 'stop',
              },
            ],
          });
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        } catch (err) {
          if (closed) return;
          const message = err instanceof Error ? err.message : 'unknown_error';
          emit({
            choices: [
              {
                index: 0,
                delta: { content: `\n\n❌ ensemble error: ${message}` },
                finish_reason: 'error',
              },
            ],
          });
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        } finally {
          req.signal.removeEventListener('abort', abortOnClient);
          if (!closed) {
            closed = true;
            try {
              controller.close();
            } catch {
              /* ignore */
            }
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    });
  }

  // --- Branch FreeLLMAPI (riserva AI pubblica di Solco) -------------------
  if (model === 'freellmapi' || model.startsWith('freellmapi:')) {
    const apiKey = (process.env.FREELLMAPI_API_KEY ?? process.env.FREELLMAPI_TOKEN)?.trim();
    if (!apiKey) {
      return NextResponse.json(
        { error: 'FREELLMAPI_API_KEY non impostata (.env.local).' },
        { status: 500 },
      );
    }
    const baseUrl = (
      process.env.FREELLMAPI_BASE_URL?.trim() || 'https://www.solcomusic.online/api/ai-reserve/v1'
    ).replace(/\/+$/, '');
    const upstreamModel = model.startsWith('freellmapi:')
      ? model.slice('freellmapi:'.length) || 'auto'
      : 'auto';

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let closed = false;
        const emit = (obj: unknown) => {
          if (closed) return;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        };
        emit({
          id: `freellmapi-${Date.now()}`,
          model: `freellmapi/${upstreamModel}`,
          choices: [{ index: 0, delta: { role: 'assistant' } }],
        });

        const abortOnClient = () => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        req.signal.addEventListener('abort', abortOnClient);
        const timer = setTimeout(() => abortOnClient(), UPSTREAM_TIMEOUT_MS);

        try {
          const res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${apiKey}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              model: upstreamModel,
              messages: [{ role: 'user', content: prompt }],
              stream: false,
              ...(typeof temperature === 'number' ? { temperature } : {}),
              ...(typeof maxTokens === 'number' ? { max_tokens: maxTokens } : {}),
            }),
            cache: 'no-store',
            signal: req.signal,
          });

          const bodyText = await res.text();
          if (closed) return;

          if (!res.ok) {
            emit({
              choices: [
                {
                  index: 0,
                  delta: { content: `\n\n❌ HTTP ${res.status} — ${bodyText.slice(0, 300)}` },
                  finish_reason: 'error',
                },
              ],
            });
          } else {
            let body: unknown = null;
            try {
              body = JSON.parse(bodyText);
            } catch {
              /* rimarrà null */
            }
            const bodyObj = isRecord(body) ? body : {};
            const choices = Array.isArray(bodyObj.choices) ? bodyObj.choices : [];
            const choice = isRecord(choices[0]) ? choices[0] : null;
            const message = choice && isRecord(choice.message) ? choice.message : null;
            const content = typeof message?.content === 'string' ? message.content : '';
            const reasoning = typeof message?.reasoning === 'string' ? message.reasoning : null;
            const finishReason =
              typeof choice?.finish_reason === 'string' ? choice.finish_reason : 'stop';
            const resolvedModel = typeof bodyObj.model === 'string' ? bodyObj.model : upstreamModel;
            const usageRaw = isRecord(bodyObj.usage) ? bodyObj.usage : null;

            // Un unico chunk col testo intero (upstream non streama davvero).
            emit({
              model: `freellmapi/${resolvedModel}`,
              choices: [
                {
                  index: 0,
                  delta: {
                    ...(content ? { content } : {}),
                    ...(reasoning ? { reasoning } : {}),
                  },
                  finish_reason: finishReason,
                },
              ],
              ...(usageRaw ? { usage: usageRaw } : {}),
            });
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        } catch (err) {
          if (closed) return;
          const aborted = err instanceof Error && err.name === 'AbortError';
          emit({
            choices: [
              {
                index: 0,
                delta: {
                  content: aborted
                    ? `\n\n❌ Timeout dopo ${Math.round(UPSTREAM_TIMEOUT_MS / 1000)}s`
                    : `\n\n❌ ${err instanceof Error ? err.message : 'unknown_error'}`,
                },
                finish_reason: 'error',
              },
            ],
          });
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        } finally {
          clearTimeout(timer);
          req.signal.removeEventListener('abort', abortOnClient);
          if (!closed) {
            closed = true;
            try {
              controller.close();
            } catch {
              /* ignore */
            }
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    });
  }

  // --- Branch gateway OpenAI-compatible -----------------------------------
  const cfg = readConfig();
  if ('error' in cfg) {
    return NextResponse.json({ error: cfg.error }, { status: 500 });
  }

  // Timeout upstream + propagazione del disconnect del client (cancel del fetch
  // nel browser deve davvero fermare la chiamata al gateway).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  const onClientAbort = () => controller.abort();
  req.signal.addEventListener('abort', onClientAbort);

  const cleanup = () => {
    clearTimeout(timer);
    req.signal.removeEventListener('abort', onClientAbort);
  };

  try {
    const upstream = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: true,
        stream_options: { include_usage: true },
        ...(typeof temperature === 'number' ? { temperature } : {}),
        ...(typeof maxTokens === 'number' ? { max_tokens: maxTokens } : {}),
      }),
      cache: 'no-store',
      signal: controller.signal,
    });

    if (!upstream.ok || !upstream.body) {
      const bodyText = await upstream.text().catch(() => '');
      const detail = bodyText ? bodyText.slice(0, 400) : '';
      const latencyMs = Date.now() - started;
      const result: CompareResult = {
        model,
        status: 'error',
        error: `HTTP ${upstream.status}${detail ? ` — ${detail}` : ''}`,
        latencyMs,
      };
      cleanup();
      return NextResponse.json(result);
    }

    // Relay dello stream SSE upstream. Aggancio cleanup alla chiusura della
    // pipe (il timer scade col setTimeout non cancellato se lo stream è lungo —
    // lo cancello comunque qui perché l'upstream ha accettato).
    clearTimeout(timer);

    const relayed = upstream.body.pipeThrough(
      new TransformStream({
        flush() {
          req.signal.removeEventListener('abort', onClientAbort);
        },
      }),
    );

    return new Response(relayed, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    });
  } catch (err) {
    cleanup();
    const latencyMs = Date.now() - started;
    const aborted = err instanceof Error && err.name === 'AbortError';
    const result: CompareResult = {
      model,
      status: 'error',
      error: aborted
        ? `Timeout dopo ${Math.round(UPSTREAM_TIMEOUT_MS / 1000)}s`
        : err instanceof Error
          ? err.message
          : 'unknown_error',
      latencyMs,
    };
    return NextResponse.json(result);
  }
}

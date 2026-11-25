// @polsia:user-owned — proxy OpenAI-compatible verso due backend:
//   • "freellmapi" (+ varianti :ensemble/:committee) → riserva AI pubblica di
//     Solco (www.solcomusic.online/api/ai-reserve/v1). Non streama: la route
//     avvolge la risposta JSON in un singolo delta SSE finto
//   • qualsiasi altro id → gateway LOCAL_LLM_BASE_URL (OpenAI-compatible),
//     relay diretto della SSE con stream_options.include_usage
//
// Nota: ARTEX è stato rimosso da /compare (è task-oriented, non chat).
// L'adapter /api/artex-llm/v1 e /api/artex-admin/* restano per uso via task.
//
// Una chiamata = un modello. Il client fa fan-out di N richieste parallele a
// questa route, così le risposte compaiono una a una.
//
// Variabili d'ambiente richieste (in .env.local):
//   LOCAL_LLM_BASE_URL   es. http://192.168.0.117:8080 (gateway OpenAI)
//   LOCAL_LLM_KEY        bearer token del gateway
//   FREELLMAPI_API_KEY   bearer della riserva Solco (solo per "freellmapi*");
//                         fallback: FREELLMAPI_TOKEN
//   FREELLMAPI_BASE_URL  facoltativo; default https://www.solcomusic.online/api/ai-reserve/v1

import 'server-only';
import { NextResponse } from 'next/server';
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

  // --- Branch FreeLLMAPI COMMITTEE (1 call, 90 agent simulati nel prompt) --
  // Deve stare PRIMA del branch generico "freellmapi:*".
  if (model === 'freellmapi:committee') {
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

    // System prompt del "comitato": un unico modello (gpt-oss-120b, grosso)
    // consulta mentalmente 90 micro-specialisti prima di scrivere. Il numero
    // è didattico — serve ad ancorare la risposta su una moltitudine di
    // prospettive concrete piuttosto che una generica.
    const COMMITTEE_SYSTEM = [
      'Sei un comitato di 90 agenti specialisti compatti. Prima di rispondere, consulta mentalmente gli esperti la cui competenza è più pertinente alla domanda, tra queste famiglie (ne ha ciascuna ~10): statistici e data scientist; ingegneri del software, sistemisti, SRE; ingegneri di sicurezza, pentester, crittografi; UX designer, product manager, ricercatori utenti; economisti, analisti finanziari, contabili; biologi, chimici, fisici; medici, farmacisti, nutrizionisti; avvocati, revisori, compliance officer; insegnanti, copywriter, editor; etici, filosofi, storici.',
      '',
      "Metodo: (1) individua 3-7 specialisti pertinenti; (2) chiedi a ciascuno un contributo di una frase o un dato; (3) sintetizza una risposta singola, concisa, direttamente all'utente nella sua lingua. Non elencare gli specialisti, non mostrare il processo, non nominare 'comitato' o 'agenti'. Correggi gli errori di fatto, scarta le ridondanze, mantieni le precisazioni utili. Se la domanda è ambigua, chiedi chiarimenti anziché inventare.",
    ].join('\n');

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
            id: `freellmapi-committee-${Date.now()}`,
            model: 'freellmapi/committee',
            choices: [{ index: 0, delta: { role: 'assistant' } }],
          });

          const res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${apiKey}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              model: 'openai/gpt-oss-120b',
              messages: [
                { role: 'system', content: COMMITTEE_SYSTEM },
                { role: 'user', content: prompt },
              ],
              stream: false,
              temperature: typeof temperature === 'number' ? temperature : 0.3,
              ...(typeof maxTokens === 'number' ? { max_tokens: maxTokens } : {}),
            }),
            cache: 'no-store',
            signal: req.signal,
          });

          if (!res.ok) {
            const txt = await res.text().catch(() => '');
            emit({
              choices: [
                {
                  index: 0,
                  delta: {
                    content: `\n\n❌ HTTP ${res.status} — ${txt.slice(0, 300)}`,
                  },
                  finish_reason: 'error',
                },
              ],
            });
          } else {
            const body: unknown = await res.json();
            const bodyObj = isRecord(body) ? body : {};
            const choices = Array.isArray(bodyObj.choices) ? bodyObj.choices : [];
            const choice = isRecord(choices[0]) ? choices[0] : null;
            const message = choice && isRecord(choice.message) ? choice.message : null;
            const content = typeof message?.content === 'string' ? message.content : '';
            const usageRaw = isRecord(bodyObj.usage) ? bodyObj.usage : null;
            emit({
              model: `freellmapi/committee (90 simulated specialists on gpt-oss-120b)`,
              choices: [
                {
                  index: 0,
                  delta: { content },
                  finish_reason: 'stop',
                },
              ],
              ...(usageRaw ? { usage: usageRaw } : {}),
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
                delta: { content: `\n\n❌ committee error: ${message}` },
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

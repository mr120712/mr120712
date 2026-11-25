// @polsia:user-owned — playground di confronto multi-modello sul gateway LLM
// locale. Fan-out di N richieste parallele a /api/compare in streaming SSE
// (OpenAI-compatible): ogni card si riempie token per token.
'use client';

import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  COMPARE_MODELS,
  type CompareProvider,
  groupedModels,
  providerOf,
} from '@/lib/compare-models';
import type { CompareResult } from '@/lib/contracts/compare';

type RunState = 'pending' | 'running' | 'ok' | 'error';

interface Row {
  model: string;
  state: RunState;
  result?: CompareResult;
}

const PROVIDER_ORDER: CompareProvider[] = ['auto', 'artex', 'kilo', 'ovh', 'aihorde'];

const DEFAULT_SELECTED = new Set<string>([
  'auto',
  'kilo:nvidia/nemotron-3-ultra-550b-a55b:free',
  'ovh:Qwen3.5-397B-A17B',
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Streama /api/compare e aggiorna la Row via `onUpdate`. Risolve quando lo
 * stream finisce (o il server ha risposto con una busta JSON di errore).
 * Lanciare => propagarlo al chiamante solo se NON è un abort.
 */
async function streamCompare(
  payload: Record<string, unknown>,
  signal: AbortSignal,
  onUpdate: (patch: Partial<CompareResult>, state: RunState) => void,
): Promise<void> {
  const started = performance.now();
  const res = await fetch('/api/compare', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });

  const contentType = res.headers.get('content-type') ?? '';

  // Error branch: la route restituisce JSON ({error}|{errors}|CompareResult).
  if (!contentType.includes('text/event-stream')) {
    const body = await res.json().catch(() => null);
    const latencyMs = Math.round(performance.now() - started);
    let message = `HTTP ${res.status}`;
    if (isRecord(body)) {
      if ('error' in body && typeof body.error === 'string') message = body.error;
      else if ('errors' in body && isRecord(body.errors)) {
        message = Object.entries(body.errors)
          .map(([k, v]) => `${k}: ${String(v)}`)
          .join('; ');
      }
    }
    onUpdate({ status: 'error', error: message, latencyMs }, 'error');
    return;
  }

  if (!res.body) {
    onUpdate({ status: 'error', error: 'risposta senza body', latencyMs: 0 }, 'error');
    return;
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let resolvedModel: string | null = null;
  let finishReason: string | null = null;
  let usage: CompareResult['usage'] = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    // SSE: eventi separati da linea vuota. Un evento può avere più righe
    // `data: …`; le concatena.
    let sepIndex = buffer.indexOf('\n\n');
    while (sepIndex !== -1) {
      const rawEvent = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);
      sepIndex = buffer.indexOf('\n\n');
      const dataLines: string[] = [];
      for (const line of rawEvent.split('\n')) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length === 0) continue;
      const data = dataLines.join('\n');
      if (data === '[DONE]') continue;
      let payload: unknown;
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }
      if (!isRecord(payload)) continue;
      if (typeof payload.model === 'string' && !resolvedModel) resolvedModel = payload.model;
      const choices = Array.isArray(payload.choices) ? payload.choices : [];
      const choice = isRecord(choices[0]) ? choices[0] : null;
      if (choice) {
        const delta = isRecord(choice.delta) ? choice.delta : null;
        if (delta) {
          if (typeof delta.content === 'string') content += delta.content;
          if (typeof delta.reasoning === 'string') reasoning += delta.reasoning;
        }
        if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
      }
      const usageRaw = isRecord(payload.usage) ? payload.usage : null;
      if (usageRaw) {
        usage = {
          promptTokens:
            typeof usageRaw.prompt_tokens === 'number' ? usageRaw.prompt_tokens : undefined,
          completionTokens:
            typeof usageRaw.completion_tokens === 'number' ? usageRaw.completion_tokens : undefined,
          totalTokens:
            typeof usageRaw.total_tokens === 'number' ? usageRaw.total_tokens : undefined,
        };
      }
      const latencyMs = Math.round(performance.now() - started);
      onUpdate(
        {
          status: 'ok',
          content,
          reasoning: reasoning || null,
          resolvedModel,
          finishReason,
          usage,
          latencyMs,
          error: null,
        },
        'running',
      );
    }
  }

  const latencyMs = Math.round(performance.now() - started);
  onUpdate(
    {
      status: 'ok',
      content,
      reasoning: reasoning || null,
      resolvedModel,
      finishReason,
      usage,
      latencyMs,
      error: null,
    },
    'ok',
  );
}

export default function ComparePage() {
  const [prompt, setPrompt] = useState('Dimmi qualcosa di interessante sulla musica.');
  const [temperature, setTemperature] = useState<string>('');
  const [maxTokens, setMaxTokens] = useState<string>('512');
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set(DEFAULT_SELECTED));
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const groups = useMemo(() => groupedModels(), []);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return COMPARE_MODELS;
    return COMPARE_MODELS.filter((m) => m.toLowerCase().includes(q));
  }, [filter]);

  function toggle(model: string, next: boolean) {
    setSelected((prev) => {
      const out = new Set(prev);
      if (next) out.add(model);
      else out.delete(model);
      return out;
    });
  }

  function toggleProvider(provider: CompareProvider, next: boolean) {
    setSelected((prev) => {
      const out = new Set(prev);
      for (const m of groups[provider]) {
        if (next) out.add(m);
        else out.delete(m);
      }
      return out;
    });
  }

  function clearAll() {
    setSelected(new Set());
  }

  function cancel() {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
    setRows((prev) =>
      prev.map((r) =>
        r.state === 'running' || r.state === 'pending'
          ? {
              ...r,
              state: 'error',
              result: {
                ...(r.result ?? { model: r.model, status: 'error', latencyMs: 0 }),
                status: 'error',
                error: 'Annullato',
              },
            }
          : r,
      ),
    );
  }

  function patchRow(model: string, patch: Partial<CompareResult>, nextState: RunState) {
    setRows((prev) =>
      prev.map((r) => {
        if (r.model !== model) return r;
        const base: CompareResult = r.result ?? {
          model,
          status: patch.status ?? 'ok',
          latencyMs: 0,
        };
        return { ...r, state: nextState, result: { ...base, ...patch, model } };
      }),
    );
  }

  async function run() {
    if (!prompt.trim()) {
      toast.error('Inserisci un prompt.');
      return;
    }
    if (selected.size === 0) {
      toast.error('Seleziona almeno un modello.');
      return;
    }
    const models = Array.from(selected);
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setRows(models.map((model) => ({ model, state: 'running' })));

    const temp = temperature.trim() === '' ? undefined : Number(temperature);
    const mt = maxTokens.trim() === '' ? undefined : Number(maxTokens);

    await Promise.all(
      models.map(async (model) => {
        try {
          await streamCompare(
            {
              model,
              prompt,
              ...(Number.isFinite(temp) ? { temperature: temp } : {}),
              ...(Number.isFinite(mt) ? { maxTokens: mt } : {}),
            },
            controller.signal,
            (patch, state) => patchRow(model, patch, state),
          );
        } catch (err) {
          if (controller.signal.aborted) return;
          const message = err instanceof Error ? err.message : 'errore sconosciuto';
          patchRow(model, { status: 'error', error: message, latencyMs: 0 }, 'error');
        }
      }),
    );

    if (abortRef.current === controller) abortRef.current = null;
    setRunning(false);
  }

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Confronto modelli</h1>
        <p className="text-sm text-muted-foreground">
          Manda lo stesso prompt a più modelli del gateway locale e vedi le risposte una accanto
          all&apos;altra, in streaming.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Prompt</CardTitle>
          <CardDescription>Testo inviato a ogni modello selezionato.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            placeholder="Scrivi il prompt…"
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="temperature">Temperatura (opzionale, 0–2)</Label>
              <Input
                id="temperature"
                type="number"
                step="0.1"
                min="0"
                max="2"
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
                placeholder="es. 0.7"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="max-tokens">Max token (opzionale, 1–4096)</Label>
              <Input
                id="max-tokens"
                type="number"
                step="1"
                min="1"
                max="4096"
                value={maxTokens}
                onChange={(e) => setMaxTokens(e.target.value)}
                placeholder="es. 512"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <CardTitle>Modelli</CardTitle>
            <CardDescription>
              {selected.size} selezionati su {COMPARE_MODELS.length}.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder="Cerca per nome…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="max-w-sm"
            />
            <Button type="button" variant="outline" size="sm" onClick={clearAll}>
              Deseleziona tutti
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {PROVIDER_ORDER.map((provider) => {
            const all = groups[provider];
            const visible = all.filter((m) => filtered.includes(m));
            if (visible.length === 0) return null;
            const selectedInGroup = all.filter((m) => selected.has(m)).length;
            const allChecked = selectedInGroup === all.length;
            return (
              <section key={provider} className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold uppercase tracking-wide">{provider}</h3>
                    <Badge variant="secondary">
                      {selectedInGroup}/{all.length}
                    </Badge>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => toggleProvider(provider, !allChecked)}
                  >
                    {allChecked ? 'Deseleziona gruppo' : 'Seleziona gruppo'}
                  </Button>
                </div>
                <div className="grid grid-cols-1 gap-x-4 gap-y-1 md:grid-cols-2">
                  {visible.map((model) => {
                    const id = `m-${model}`;
                    return (
                      <label
                        key={model}
                        htmlFor={id}
                        className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted/50"
                      >
                        <Checkbox
                          id={id}
                          checked={selected.has(model)}
                          onCheckedChange={(v) => toggle(model, v === true)}
                        />
                        <span className="truncate font-mono text-xs">{model}</span>
                      </label>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </CardContent>
      </Card>

      <div className="sticky bottom-4 z-10 flex justify-center">
        {running ? (
          <Button type="button" variant="destructive" size="lg" onClick={cancel}>
            Annulla
          </Button>
        ) : (
          <Button type="button" size="lg" onClick={run} disabled={selected.size === 0}>
            Esegui ({selected.size})
          </Button>
        )}
      </div>

      {rows.length > 0 && (
        <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {rows.map((row) => (
            <ResultCard key={row.model} row={row} />
          ))}
        </section>
      )}
    </main>
  );
}

function ResultCard({ row }: { row: Row }) {
  const provider = providerOf(row.model);
  const streaming = row.state === 'running' && !!row.result?.content;
  return (
    <Card>
      <CardHeader className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="font-mono text-xs break-all">{row.model}</CardTitle>
          <Badge
            variant={
              row.state === 'ok' ? 'default' : row.state === 'error' ? 'destructive' : 'secondary'
            }
          >
            {row.state === 'running' ? (streaming ? 'streaming…' : 'in attesa…') : row.state}
          </Badge>
        </div>
        <CardDescription className="flex flex-wrap gap-2 text-xs">
          <span>{provider}</span>
          {row.result?.latencyMs ? <span>{row.result.latencyMs} ms</span> : null}
          {row.result?.resolvedModel ? <span>→ {row.result.resolvedModel}</span> : null}
          {row.result?.finishReason ? <span>finish: {row.result.finishReason}</span> : null}
          {row.result?.usage?.totalTokens ? (
            <span>
              {row.result.usage.promptTokens ?? '?'}+{row.result.usage.completionTokens ?? '?'}=
              {row.result.usage.totalTokens} tok
            </span>
          ) : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="text-sm">
        {row.state === 'running' && !row.result?.content && !row.result?.reasoning && (
          <p className="text-muted-foreground">In attesa della risposta…</p>
        )}
        {row.state === 'error' && (
          <p className="text-destructive whitespace-pre-wrap break-words">
            {row.result?.error ?? 'Errore'}
          </p>
        )}
        {(row.state === 'ok' ||
          (row.state === 'running' && (row.result?.content || row.result?.reasoning))) && (
          <div className="flex flex-col gap-3">
            {row.result?.reasoning ? (
              <details
                className="rounded-md border bg-muted/40 px-3 py-2"
                open={row.state === 'running' && !row.result?.content}
              >
                <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                  Reasoning
                </summary>
                <p className="mt-2 whitespace-pre-wrap text-xs">{row.result.reasoning}</p>
              </details>
            ) : null}
            <p className="whitespace-pre-wrap break-words">
              {row.result?.content ? (
                <>
                  {row.result.content}
                  {row.state === 'running' && (
                    <span className="ml-0.5 inline-block w-1.5 animate-pulse bg-foreground align-middle">
                      &nbsp;
                    </span>
                  )}
                </>
              ) : row.state === 'ok' ? (
                <span className="text-muted-foreground">(vuoto)</span>
              ) : null}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

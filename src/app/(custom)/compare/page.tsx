// @polsia:user-owned — playground di confronto multi-modello sul gateway LLM
// locale. Fan-out di N richieste parallele a /api/compare, card per modello
// che si popolano a mano a mano.
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
import { apiFetch } from '@/lib/api-client';
import {
  COMPARE_MODELS,
  type CompareProvider,
  groupedModels,
  providerOf,
} from '@/lib/compare-models';
import { CompareResult } from '@/lib/contracts/compare';

type RunState = 'pending' | 'running' | 'ok' | 'error';

interface Row {
  model: string;
  state: RunState;
  result?: CompareResult;
}

const PROVIDER_ORDER: CompareProvider[] = ['auto', 'kilo', 'ovh', 'aihorde'];

const DEFAULT_SELECTED = new Set<string>([
  'auto',
  'kilo:nvidia/nemotron-3-ultra-550b-a55b:free',
  'ovh:Qwen3.5-397B-A17B',
]);

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
              model: r.model,
              state: 'error',
              result: { model: r.model, status: 'error', error: 'Annullato', latencyMs: 0 },
            }
          : r,
      ),
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
          const result = await apiFetch('/api/compare', {
            method: 'POST',
            body: JSON.stringify({
              model,
              prompt,
              ...(Number.isFinite(temp) ? { temperature: temp } : {}),
              ...(Number.isFinite(mt) ? { maxTokens: mt } : {}),
            }),
            schema: CompareResult,
            signal: controller.signal,
          });
          setRows((prev) =>
            prev.map((r) =>
              r.model === model
                ? { model, state: result.status === 'ok' ? 'ok' : 'error', result }
                : r,
            ),
          );
        } catch (err) {
          if (controller.signal.aborted) return;
          // apiFetch mette il body del server in err.cause: preferisci il
          // suo messaggio/errori a "apiFetch … failed (500)".
          const cause = err instanceof Error ? err.cause : null;
          const serverMessage =
            cause && typeof cause === 'object' && 'error' in cause
              ? String((cause as { error: unknown }).error)
              : cause && typeof cause === 'object' && 'errors' in cause
                ? Object.entries((cause as { errors: Record<string, string> }).errors)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join('; ')
                : null;
          const message =
            serverMessage ?? (err instanceof Error ? err.message : 'errore sconosciuto');
          setRows((prev) =>
            prev.map((r) =>
              r.model === model
                ? {
                    model,
                    state: 'error',
                    result: { model, status: 'error', error: message, latencyMs: 0 },
                  }
                : r,
            ),
          );
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
          all&apos;altra.
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
            {row.state === 'running' ? 'in corso…' : row.state}
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
        {row.state === 'running' && (
          <p className="text-muted-foreground">In attesa della risposta…</p>
        )}
        {row.state === 'error' && (
          <p className="text-destructive whitespace-pre-wrap break-words">
            {row.result?.error ?? 'Errore'}
          </p>
        )}
        {row.state === 'ok' && (
          <div className="flex flex-col gap-3">
            {row.result?.reasoning ? (
              <details className="rounded-md border bg-muted/40 px-3 py-2">
                <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                  Reasoning
                </summary>
                <p className="mt-2 whitespace-pre-wrap text-xs">{row.result.reasoning}</p>
              </details>
            ) : null}
            <p className="whitespace-pre-wrap break-words">
              {row.result?.content ?? <span className="text-muted-foreground">(vuoto)</span>}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// @polsia:user-owned — pannello «In evidenza nella Home» della pagina admin /admin/audiocom: le
// collection (album, playlist…) dell'account audio.com collegato, da spuntare per mostrarle in Home
// (al massimo 6) e da mettere in ordine. «Salva» manda la scelta (PUT /api/admin/audiocom/collections,
// il server ricontrolla che siano dell'account) e la Home cambia entro pochi minuti. Esiti delle
// azioni nei toast; errori di caricamento nel pannello con «Riprova».
'use client';

import { ArrowDown, ArrowUp, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { ZodError } from 'zod';
import { Panel } from '@/components/custom/app-ui/panel';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { apiFetch } from '@/lib/api-client';
import { requestErrorMessage } from '@/lib/business/request-error-message';
import {
  AUDIOCOM_FEATURED_COLLECTIONS_MAX,
  type AudioComCollectionsAdminResponse,
  AudioComCollectionsAdminResponseSchema,
} from '@/lib/contracts/audiocom-collections';

export const AUDIOCOM_COLLECTIONS_ENDPOINT = '/api/admin/audiocom/collections';

function loadErrorText(error: unknown): string {
  if (error instanceof ZodError) return 'Risposta del server non valida.';
  if (error instanceof TypeError) return 'Connessione non riuscita: controlla la rete.';
  const cause =
    error instanceof Error && typeof error.cause === 'object' && error.cause !== null
      ? (error.cause as { message?: unknown })
      : null;
  if (typeof cause?.message === 'string' && cause.message.trim()) return cause.message.trim();
  return 'Le collection di audio.com non sono disponibili. Riprova.';
}

/** Messaggio di un salvataggio non riuscito: errore del campo, messaggio del server o generico. */
function saveErrorText(error: unknown): string {
  const cause =
    error instanceof Error && typeof error.cause === 'object' && error.cause !== null
      ? (error.cause as { errors?: { collectionIds?: unknown }; message?: unknown })
      : null;
  if (typeof cause?.errors?.collectionIds === 'string') return cause.errors.collectionIds;
  if (typeof cause?.message === 'string' && cause.message.trim()) return cause.message.trim();
  return requestErrorMessage(error, 'Non è stato possibile salvare la scelta. Riprova.');
}

function itemsLabel(count: number): string {
  return count === 1 ? '1 brano' : `${count} brani`;
}

export function AudioComFeaturedAdmin() {
  const [data, setData] = useState<AudioComCollectionsAdminResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const orderHeadingId = useId();

  const load = useCallback(async () => {
    try {
      const body = await apiFetch(AUDIOCOM_COLLECTIONS_ENDPOINT, {
        schema: AudioComCollectionsAdminResponseSchema,
      });
      setData(body);
      setSelected(body.featuredIds);
      setLoadError(null);
    } catch (error) {
      setLoadError(loadErrorText(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const titleOf = (id: string) =>
    data?.collections.find((collection) => collection.id === id)?.title ?? `Collection ${id}`;
  const dirty = data !== null && selected.join(',') !== data.featuredIds.join(',');

  const toggle = (id: string, checked: boolean) => {
    setSelected((current) => {
      if (!checked) return current.filter((value) => value !== id);
      if (current.includes(id)) return current;
      if (current.length >= AUDIOCOM_FEATURED_COLLECTIONS_MAX) {
        toast.error(`Al massimo ${AUDIOCOM_FEATURED_COLLECTIONS_MAX} collection in Home.`);
        return current;
      }
      return [...current, id];
    });
  };

  const move = (index: number, delta: -1 | 1) => {
    setSelected((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      const [item] = next.splice(index, 1);
      if (item !== undefined) next.splice(target, 0, item);
      return next;
    });
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const body = await apiFetch(AUDIOCOM_COLLECTIONS_ENDPOINT, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ collectionIds: selected }),
        schema: AudioComCollectionsAdminResponseSchema,
      });
      setData(body);
      setSelected(body.featuredIds);
      toast.success(
        body.featuredIds.length > 0
          ? 'Scelta salvata: la Home si aggiorna entro pochi minuti.'
          : 'Nessuna collection in Home: le sezioni di audio.com spariscono entro pochi minuti.',
      );
    } catch (error) {
      toast.error(saveErrorText(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel
      title="In evidenza nella Home"
      description={`Scegli fino a ${AUDIOCOM_FEATURED_COLLECTIONS_MAX} collection del tuo account audio.com (album o playlist): la Home le mostra come sezioni, nell’ordine.`}
      actions={
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void load()}
          aria-label="Aggiorna l’elenco delle collection"
        >
          <RefreshCw aria-hidden="true" />
          Aggiorna
        </Button>
      }
    >
      {loadError && !data ? (
        <p role="alert" className="text-sm text-destructive">
          {loadError}
        </p>
      ) : !data ? (
        <p className="text-sm text-muted-foreground">Caricamento delle collection…</p>
      ) : data.status === 'disconnected' ? (
        <p className="text-sm text-muted-foreground">Collega prima l’account audio.com (sopra).</p>
      ) : data.status === 'unavailable' ? (
        <p className="text-sm text-muted-foreground">
          audio.com non risponde in questo momento: premi «Aggiorna» tra poco.
        </p>
      ) : data.collections.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nessuna collection su questo account. Crea un album o una playlist su audio.com, aggiungi
          i brani e premi «Aggiorna».
        </p>
      ) : (
        <div className="grid gap-5">
          <ul className="grid gap-2" aria-label="Le tue collection su audio.com">
            {data.collections.map((collection) => {
              const checkboxId = `audiocom-collection-${collection.id}`;
              const checked = selected.includes(collection.id);
              return (
                <li
                  key={collection.id}
                  className="flex items-start gap-3 rounded-lg border border-border p-3"
                >
                  <Checkbox
                    id={checkboxId}
                    checked={checked}
                    onCheckedChange={(value) => toggle(collection.id, value === true)}
                    className="mt-0.5"
                  />
                  <label htmlFor={checkboxId} className="grid min-w-0 gap-0.5 text-sm">
                    <span className="font-medium text-foreground">{collection.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {[collection.type || 'collection', itemsLabel(collection.itemsCount)]
                        .concat(collection.listed ? [] : ['non pubblica su audio.com'])
                        .join(' · ')}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>

          <div className="grid gap-2">
            <h3 id={orderHeadingId} className="text-sm font-semibold">
              Ordine in Home ({selected.length} di {AUDIOCOM_FEATURED_COLLECTIONS_MAX})
            </h3>
            {selected.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nessuna collection scelta: la Home non mostra sezioni di audio.com.
              </p>
            ) : (
              <ol className="grid gap-2" aria-labelledby={orderHeadingId}>
                {selected.map((id, index) => (
                  <li
                    key={id}
                    className="flex items-center justify-between gap-2 rounded-lg bg-muted/40 px-3 py-2 text-sm"
                  >
                    <span className="min-w-0 truncate">
                      {index + 1}. {titleOf(id)}
                    </span>
                    <span className="flex shrink-0 gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        disabled={index === 0}
                        onClick={() => move(index, -1)}
                        aria-label={`Sposta su: ${titleOf(id)}`}
                      >
                        <ArrowUp aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        disabled={index === selected.length - 1}
                        onClick={() => move(index, 1)}
                        aria-label={`Sposta giù: ${titleOf(id)}`}
                      >
                        <ArrowDown aria-hidden="true" />
                      </Button>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>

          <p className="text-xs leading-5 text-muted-foreground">
            In Home compaiono solo i brani musicali pubblici. Si ascoltano nel player di Solco
            quelli con licenza CC0, CC BY, CC BY-SA o CC BY-ND (mai le cover); gli altri con il
            player ufficiale di audio.com. Carica su audio.com solo musica tua o con licenza.
          </p>

          <div>
            <Button type="button" onClick={() => void save()} disabled={!dirty || saving}>
              {saving ? 'Salvo…' : 'Salva la scelta'}
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}

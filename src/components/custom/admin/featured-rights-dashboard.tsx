// @polsia:user-owned — pagina /admin/diritti-testi: diagnosi dei "brani in evidenza" (store Vercel
// Blob). Per ogni brano dice se è ricercabile (voce valida in diritti.json) e, per i brani
// dichiarati con "testo": true, se il testo c'è e da dove viene. Mostra lo stato di diritti.json
// con le voci scartate o ignorate e il perché, più una guida. Legge solo /api/admin/featured-rights.
// È una DIAGNOSI: qui non compare MAI il testo dei brani (la risposta non lo contiene) e non ci
// sono scorciatoie per dichiarare brani in blocco: solo "Copia percorso" del singolo file.
'use client';

import {
  CircleX,
  ClipboardCopy,
  FileCheck2,
  Music2,
  RefreshCw,
  RotateCw,
  TriangleAlert,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ZodError } from 'zod';
import { AppSurface } from '@/components/custom/app-ui/app-shell';
import { EmptyState } from '@/components/custom/app-ui/empty-state';
import { ListToolbar } from '@/components/custom/app-ui/list-toolbar';
import { MetricCard, MetricGrid } from '@/components/custom/app-ui/metrics';
import { PageHeader } from '@/components/custom/app-ui/page-header';
import { Panel } from '@/components/custom/app-ui/panel';
import { StatusBadge } from '@/components/custom/app-ui/status-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api-client';
import {
  type AdminFeaturedRights,
  AdminFeaturedRightsSchema,
  type FeaturedRightsManifest,
  type FeaturedRightsManifestStatus,
  type FeaturedRightsProblem,
  type FeaturedRightsTrack,
} from '@/lib/contracts/admin-featured-rights';
import styles from './featured-rights-dashboard.module.css';

const ENDPOINT = '/api/admin/featured-rights';
const ERROR_TEXT_MAX = 300;
/** Brani mostrati per volta ("Mostra altri"). */
export const TRACKS_PAGE_SIZE = 50;
/** Voci con problemi mostrate prima di "Mostra tutte". */
export const PROBLEMS_PAGE_SIZE = 50;

const ERROR_CODE_TEXT: Record<string, string> = {
  unauthorized: 'La sessione è scaduta: accedi di nuovo.',
  forbidden: 'Serve un account amministratore con email verificata.',
  session_unavailable: 'Non riesco a verificare la sessione in questo momento. Riprova tra poco.',
};

const numberFormat = new Intl.NumberFormat('it-IT');
const percentFormat = new Intl.NumberFormat('it-IT', {
  style: 'percent',
  maximumFractionDigits: 0,
});
const timeFormat = new Intl.DateTimeFormat('it-IT', {
  timeZone: 'Europe/Rome',
  hour: '2-digit',
  minute: '2-digit',
});

const LICENCE_LABELS: Record<string, string> = {
  propria: 'brano proprio',
  licenza: 'licenza per contratto',
  cc0: 'CC0 (pubblico dominio)',
  'cc-by': 'CC BY',
  'cc-by-sa': 'CC BY-SA',
  'cc-by-nd': 'CC BY-ND',
};

const FOUND = new Set(['lrc', 'txt', 'embedded']);

export type TrackFilter =
  | 'all'
  | 'declared'
  | 'undeclared'
  | 'lyrics_on'
  | 'lyrics_found'
  | 'lyrics_missing';

const FILTERS: ReadonlyArray<{
  id: TrackFilter;
  label: string;
  test: (track: FeaturedRightsTrack) => boolean;
}> = [
  { id: 'all', label: 'Tutti', test: () => true },
  { id: 'declared', label: 'Dichiarati', test: (track) => track.declared },
  { id: 'undeclared', label: 'Non dichiarati', test: (track) => !track.declared },
  { id: 'lyrics_on', label: 'Testo attivo', test: (track) => track.testo },
  {
    id: 'lyrics_found',
    label: 'Testo trovato',
    test: (track) => FOUND.has(track.lyrics.status),
  },
  {
    id: 'lyrics_missing',
    label: 'Testo mancante',
    test: (track) =>
      track.testo && (track.lyrics.status === 'none' || track.lyrics.status === 'error'),
  },
];

function formatCount(value: number) {
  return numberFormat.format(value);
}

function formatTime(iso: string) {
  return timeFormat.format(new Date(iso));
}

function plural(count: number, one: string, many: string) {
  return count === 1 ? `1 ${one}` : `${formatCount(count)} ${many}`;
}

/** Minuscole e senza accenti, per cercare "citta" e trovare "Città". */
function fold(value: string) {
  return value
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
}

/** Tutte le parole della ricerca in titolo, artista, sezione o percorso. */
export function matchesTrackQuery(track: FeaturedRightsTrack, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = fold(
    [track.title, track.artist ?? '', track.section, track.pathname].join('\n'),
  );
  return words.every((word) => haystack.includes(word));
}

/** Messaggio del server quando c'è, altrimenti un testo breve in italiano. */
function failureMessage(error: unknown): string {
  if (error instanceof ZodError) return 'La risposta del server non è nel formato atteso.';
  if (error instanceof TypeError) return 'Connessione non riuscita: controlla la rete e riprova.';
  const cause =
    error instanceof Error && typeof error.cause === 'object' && error.cause !== null
      ? (error.cause as { message?: unknown; error?: unknown })
      : null;
  if (typeof cause?.message === 'string' && cause.message.trim()) {
    return cause.message.trim().slice(0, ERROR_TEXT_MAX);
  }
  const code = cause?.error;
  if (typeof code === 'string' && Object.hasOwn(ERROR_CODE_TEXT, code)) {
    return ERROR_CODE_TEXT[code] ?? '';
  }
  return 'La diagnosi di diritti e testi non è disponibile. Riprova.';
}

type State = { data: AdminFeaturedRights | null; loading: boolean; error: string | null };

export function FeaturedRightsDashboard() {
  const [state, setState] = useState<State>({ data: null, loading: true, error: null });
  const [announcement, setAnnouncement] = useState('');
  const requestRef = useRef(0);
  const loadingRef = useRef(true);

  const load = useCallback(async (announce: boolean) => {
    const request = ++requestRef.current;
    loadingRef.current = true;
    setState((current) => ({ ...current, loading: true }));
    if (announce) setAnnouncement('Aggiornamento in corso…');
    try {
      const data = await apiFetch(ENDPOINT, { schema: AdminFeaturedRightsSchema });
      if (request !== requestRef.current) return;
      setState({ data, loading: false, error: null });
      if (announce) setAnnouncement(`Dati aggiornati alle ${formatTime(data.generatedAt)}.`);
    } catch (error) {
      if (request !== requestRef.current) return;
      setState((current) => ({ ...current, loading: false, error: failureMessage(error) }));
      if (announce) setAnnouncement('Aggiornamento non riuscito.');
    } finally {
      if (request === requestRef.current) loadingRef.current = false;
    }
  }, []);

  useEffect(() => {
    void load(false);
    return () => {
      // Ignora una risposta che arriva dopo l'uscita dalla pagina.
      requestRef.current += 1;
    };
  }, [load]);

  const refresh = () => {
    if (loadingRef.current) return;
    void load(true);
  };

  const { data, loading, error } = state;

  return (
    <AppSurface className="bg-transparent">
      <PageHeader
        title="Diritti e testi"
        description="Perché un brano in evidenza è (o non è) ricercabile e se il suo testo è disponibile nel player. È solo una diagnosi: qui il testo dei brani non compare mai."
        actions={
          <Button
            type="button"
            onClick={refresh}
            aria-disabled={loading || undefined}
            className="aria-disabled:cursor-progress aria-disabled:opacity-70"
          >
            <RefreshCw aria-hidden="true" className={loading ? 'motion-safe:animate-spin' : ''} />
            {loading && data ? 'Aggiornamento…' : 'Aggiorna'}
          </Button>
        }
      />
      <div className={styles.status}>
        {data ? (
          <p>
            Aggiornato alle <time dateTime={data.generatedAt}>{formatTime(data.generatedAt)}</time>
            {data.store.listedAt ? (
              <>
                {' '}
                · elenco dello store delle{' '}
                <time dateTime={data.store.listedAt}>{formatTime(data.store.listedAt)}</time> (si
                rilegge al massimo ogni minuto)
              </>
            ) : null}
          </p>
        ) : null}
        <output aria-live="polite" className={styles.announcement}>
          {announcement}
        </output>
      </div>

      {error ? (
        <ErrorState message={error} stale={data !== null} onRetry={refresh} retrying={loading} />
      ) : null}
      {loading && !data && !error ? <LoadingState /> : null}
      {data ? <Report data={data} /> : null}
    </AppSurface>
  );
}

function Report({ data }: { data: AdminFeaturedRights }) {
  return (
    <>
      {data.store.status === 'partial' && data.store.reason ? (
        <div className={styles.notice}>
          <TriangleAlert aria-hidden="true" />
          <p>{data.store.reason}</p>
        </div>
      ) : null}
      <SummaryTiles data={data} />
      <ManifestPanel manifest={data.manifest} />
      <GuidePanel defaultOpen={data.manifest.status !== 'valid'} />
      <TracksPanel data={data} />
    </>
  );
}

function LoadingState() {
  return (
    <div className="grid gap-4">
      <output aria-live="polite" className="block text-sm text-muted-foreground">
        Controllo di diritti.json e dei brani in evidenza…
      </output>
      <Skeleton className="h-32 w-full motion-reduce:animate-none" />
      <Skeleton className="h-48 w-full motion-reduce:animate-none" />
      <Skeleton className="h-64 w-full motion-reduce:animate-none" />
    </div>
  );
}

function ErrorState({
  message,
  stale,
  retrying,
  onRetry,
}: {
  message: string;
  stale: boolean;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div role="alert" className={styles.error}>
      <CircleX aria-hidden="true" />
      <div className={styles.errorBody}>
        <p className="font-semibold">
          {stale ? 'Aggiornamento non riuscito.' : 'Non riesco a mostrare la diagnosi.'}
        </p>
        <p className={styles.muted}>{message}</p>
        {stale ? (
          <p className={styles.muted}>I dati qui sotto sono quelli dell’ultima lettura.</p>
        ) : null}
      </div>
      <Button
        type="button"
        variant="outline"
        onClick={onRetry}
        aria-disabled={retrying || undefined}
        className="aria-disabled:cursor-progress aria-disabled:opacity-70"
      >
        <RotateCw aria-hidden="true" />
        Riprova
      </Button>
    </div>
  );
}

const MANIFEST_STATUS: Record<
  FeaturedRightsManifestStatus,
  { label: string; tone: 'positive' | 'warning' | 'critical' | 'neutral'; text: string }
> = {
  valid: {
    label: 'Valido',
    tone: 'positive',
    text: 'diritti.json è valido: sono ricercabili i brani indicati da una voce valida.',
  },
  missing: {
    label: 'Assente',
    tone: 'warning',
    text: 'diritti.json non c’è: nessun brano in evidenza compare nella ricerca (in Home restano tutti).',
  },
  invalid: {
    label: 'Non valido',
    tone: 'critical',
    text: 'diritti.json non è valido: finché non lo correggi nessun brano in evidenza è ricercabile.',
  },
  unavailable: {
    label: 'Non leggibile',
    tone: 'neutral',
    text: 'Non riesco a leggere lo store o diritti.json in questo momento.',
  },
};

function SummaryTiles({ data }: { data: AdminFeaturedRights }) {
  const { summary, manifest } = data;
  const share =
    summary.totalTracks > 0
      ? `Ricercabili · ${percentFormat.format(summary.declared / summary.totalTracks)} dei brani`
      : 'Ricercabili';
  const lyricsDetail = [
    summary.lyricsMissing > 0 ? plural(summary.lyricsMissing, 'mancante', 'mancanti') : null,
    summary.lyricsErrors > 0 ? plural(summary.lyricsErrors, 'errore', 'errori') : null,
    summary.lyricsSkipped > 0
      ? `${summary.lyricsSkipped === 1 ? 'altro' : 'altri'} ${formatCount(summary.lyricsSkipped)} da controllare: aggiorna`
      : null,
    summary.lyricsNotShown > 0
      ? `${formatCount(summary.lyricsNotShown)} oltre i brani mostrati (non controllati)`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <MetricGrid label="Diritti e testi in sintesi">
      <MetricCard
        label="Brani nello store"
        value={formatCount(summary.totalTracks)}
        detail={data.store.status === 'partial' ? 'Elenco incompleto' : 'Come li vede la Home'}
      />
      <MetricCard label="Dichiarati" value={formatCount(summary.declared)} detail={share} />
      <MetricCard
        label="Con testo attivo"
        value={formatCount(summary.declaredWithLyrics)}
        detail="“testo”: true in diritti.json"
      />
      <MetricCard
        label="Testo trovato"
        value={formatCount(summary.lyricsFound)}
        detail={lyricsDetail || 'Su quelli con testo attivo'}
      />
      <MetricCard
        label="Problemi nel manifest"
        value={
          manifest.status === 'valid'
            ? formatCount(summary.manifestProblems)
            : MANIFEST_STATUS[manifest.status].label
        }
        detail={
          manifest.status === 'valid'
            ? `su ${plural(manifest.counts.entries, 'voce', 'voci')}`
            : 'Nessun brano ricercabile'
        }
      />
    </MetricGrid>
  );
}

function ManifestPanel({ manifest }: { manifest: FeaturedRightsManifest }) {
  const [showAll, setShowAll] = useState(false);
  const status = MANIFEST_STATUS[manifest.status];
  const problems = showAll ? manifest.problems : manifest.problems.slice(0, PROBLEMS_PAGE_SIZE);
  const hidden = manifest.problems.length - problems.length;
  return (
    <Panel
      title="diritti.json"
      description="Il manifest nella radice dello store: rende ricercabili i brani in evidenza di cui dichiari i diritti. La ricerca lo rilegge ogni ~5 minuti; qui lo vedi subito."
      actions={<StatusBadge tone={status.tone}>{status.label}</StatusBadge>}
    >
      <div className={styles.manifest}>
        <p>{status.text}</p>
        {manifest.reasons.length > 0 ? (
          <ul className={styles.reasons} aria-label="Perché">
            {manifest.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : null}
        {manifest.location ? (
          <p className={styles.muted}>
            Errore alla riga {manifest.location.line}, colonna {manifest.location.column}.
          </p>
        ) : null}
        {manifest.status === 'valid' ? (
          <>
            <dl className={styles.counts}>
              <div>
                <dt>Voci</dt>
                <dd>{formatCount(manifest.counts.entries)}</dd>
              </div>
              <div>
                <dt>Valide</dt>
                <dd>{formatCount(manifest.counts.valid)}</dd>
              </div>
              <div>
                <dt>Scartate</dt>
                <dd>{formatCount(manifest.counts.invalid)}</dd>
              </div>
              <div>
                <dt>Ignorate</dt>
                <dd>{formatCount(manifest.counts.ignored)}</dd>
              </div>
            </dl>
            {manifest.problems.length === 0 ? (
              <p className={styles.muted}>
                {manifest.counts.entries === 0
                  ? '"brani" è vuoto: nessun brano è ricercabile.'
                  : 'Tutte le voci sono valide e corrispondono a file dello store.'}
              </p>
            ) : (
              <>
                <h3 className={styles.subheading}>Voci scartate o ignorate</h3>
                <ol className={styles.problems} aria-label="Voci scartate o ignorate">
                  {problems.map((problem) => (
                    <ProblemItem key={problem.index} problem={problem} />
                  ))}
                </ol>
                {hidden > 0 ? (
                  <Button type="button" variant="outline" onClick={() => setShowAll(true)}>
                    Mostra tutte ({plural(hidden, 'altra', 'altre')})
                  </Button>
                ) : null}
              </>
            )}
          </>
        ) : null}
      </div>
    </Panel>
  );
}

function ProblemItem({ problem }: { problem: FeaturedRightsProblem }) {
  return (
    <li className={styles.problem}>
      <div className={styles.problemHead}>
        <span className="font-medium">Voce n. {problem.index}</span>
        <StatusBadge tone={problem.kind === 'invalid' ? 'critical' : 'warning'}>
          {problem.kind === 'invalid' ? 'Scartata' : 'Ignorata'}
        </StatusBadge>
      </div>
      {problem.file !== null ? (
        <code className={styles.path}>{problem.file || '(vuoto)'}</code>
      ) : (
        <span className={styles.muted}>“file” mancante o non è un testo</span>
      )}
      <ul className={styles.reasons}>
        {problem.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
    </li>
  );
}

const MANIFEST_EXAMPLE = `{
  "versione": 1,
  "brani": [
    {
      "file": "Cantautori/Autrice - Canzone.mp3",
      "licenza": "propria",
      "titolare": "Autrice",
      "testo": true
    },
    {
      "file": "Novità/Band - Singolo.flac",
      "licenza": "licenza",
      "titolare": "Etichetta Srl",
      "prova": "Contratto di distribuzione n. 42 del 03/2026"
    }
  ]
}`;

function GuidePanel({ defaultOpen }: { defaultOpen: boolean }) {
  return (
    <Panel
      title="Guida"
      description="Come dichiarare i diritti dei brani in evidenza e far comparire il testo."
    >
      <details className={styles.guide} open={defaultOpen || undefined}>
        <summary>Come scrivere diritti.json</summary>
        <div className={styles.guideBody}>
          <ol>
            <li>
              Carica il file audio nello store Vercel Blob come sempre (es.{' '}
              <code>Cantautori/Autrice - Canzone.mp3</code>).
            </li>
            <li>
              Carica (o aggiorna) nella <strong>radice</strong> dello stesso store un file chiamato
              esattamente <code>diritti.json</code>: testo UTF-8, al massimo 256 KB, caricato come{' '}
              <strong>privato</strong>.
            </li>
            <li>
              Aggiungi una voce per ogni brano di cui hai i diritti, con il percorso{' '}
              <strong>esatto</strong> (usa “Copia percorso” qui sotto).
            </li>
          </ol>
          <pre className={styles.example}>
            <code>{MANIFEST_EXAMPLE}</code>
          </pre>
          <ul>
            <li>
              <code>"versione"</code>: sempre <code>1</code>. Nessun altro campo al primo livello.
            </li>
            <li>
              <code>"licenza"</code>: <code>propria</code>, <code>licenza</code> (contratto con
              etichetta, distributore o editore), <code>cc0</code>, <code>cc-by</code>,{' '}
              <code>cc-by-sa</code> o <code>cc-by-nd</code>. Le Creative Commons non commerciali
              (NC) non sono accettate: Solco vende abbonamenti Pro.
            </li>
            <li>
              <code>"titolare"</code>: chi detiene i diritti (1-120 caratteri); <code>"prova"</code>
              : facoltativa, nota o link al contratto (al massimo 300 caratteri).
            </li>
            <li>
              <code>"testo"</code>: facoltativo, <code>true</code> o <code>false</code> senza
              virgolette. Con <code>true</code> il player mostra il testo.
            </li>
          </ul>
          <div className={styles.warning}>
            <TriangleAlert aria-hidden="true" />
            <p>
              Il testo è un’opera separata dalla registrazione e appartiene ad autori ed editori:
              una licenza sulla registrazione <strong>spesso non copre il testo</strong>. Metti{' '}
              <code>"testo": true</code> solo se hai anche questi diritti.
            </p>
          </div>
          <p>
            Il testo si legge da un file accanto al brano con lo stesso nome ed estensione{' '}
            <code>.lrc</code> (sincronizzato) o <code>.txt</code> (semplice), UTF-8, al massimo 64
            KB, caricato come privato; in mancanza, dal testo incorporato nel file audio (tag
            USLT/SYLT degli MP3, LYRICS dei FLAC/OGG, ©lyr degli M4A).
          </p>
          <div className={styles.warning} data-tone="critical">
            <TriangleAlert aria-hidden="true" />
            <p>
              <strong>Non dichiarare</strong> brani scaricati da siti che copiano Spotify o comunque
              senza licenza: una voce in diritti.json afferma che ne hai i diritti.
            </p>
          </div>
        </div>
      </details>
    </Panel>
  );
}

function TracksPanel({ data }: { data: AdminFeaturedRights }) {
  const [filter, setFilter] = useState<TrackFilter>('all');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(TRACKS_PAGE_SIZE);
  const searchId = useId();
  const listId = useId();

  const counts = useMemo(() => {
    const out = {} as Record<TrackFilter, number>;
    for (const option of FILTERS) out[option.id] = data.tracks.filter(option.test).length;
    return out;
  }, [data.tracks]);

  const filtered = useMemo(() => {
    const test = FILTERS.find((option) => option.id === filter)?.test ?? (() => true);
    return data.tracks.filter((track) => test(track) && matchesTrackQuery(track, query));
  }, [data.tracks, filter, query]);

  const visible = filtered.slice(0, limit);
  const remaining = filtered.length - visible.length;

  const chooseFilter = (next: TrackFilter) => {
    setFilter(next);
    setLimit(TRACKS_PAGE_SIZE);
  };

  return (
    <Panel
      title="Brani in evidenza"
      description="Tutti i file audio dello store, come li vede la Home, dal più recente. Un brano non dichiarato resta in Home ma non si trova cercando."
    >
      {data.tracks.length === 0 ? (
        <TracksEmptyState store={data.store} />
      ) : (
        <>
          <ListToolbar
            filters={
              <fieldset className={styles.filters}>
                <legend className="sr-only">Filtra i brani</legend>
                {FILTERS.map((option) => (
                  <Button
                    key={option.id}
                    type="button"
                    size="sm"
                    variant={filter === option.id ? 'default' : 'outline'}
                    aria-pressed={filter === option.id}
                    aria-controls={listId}
                    onClick={() => chooseFilter(option.id)}
                  >
                    {option.label}
                    <span className={styles.filterCount}>{formatCount(counts[option.id])}</span>
                  </Button>
                ))}
              </fieldset>
            }
            search={
              <div className={styles.search}>
                <Label htmlFor={searchId}>Cerca per titolo, artista o percorso</Label>
                <Input
                  id={searchId}
                  type="search"
                  value={query}
                  autoComplete="off"
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setLimit(TRACKS_PAGE_SIZE);
                  }}
                />
              </div>
            }
          />
          <output aria-live="polite" className={styles.resultCount}>
            {filtered.length === data.tracks.length
              ? plural(filtered.length, 'brano', 'brani')
              : `${plural(filtered.length, 'brano', 'brani')} su ${formatCount(data.tracks.length)}`}
            {data.tracksTruncated ? ' (solo i più recenti)' : ''}
          </output>
          {filtered.length === 0 ? (
            <EmptyState
              icon={<FileCheck2 className="size-6 text-muted-foreground" />}
              title="Nessun brano corrisponde"
              description="Cambia filtro o ricerca."
            />
          ) : (
            <ul id={listId} className={styles.tracks} aria-label="Brani in evidenza">
              {visible.map((track) => (
                <TrackItem
                  key={track.pathname}
                  track={track}
                  manifestStatus={data.manifest.status}
                />
              ))}
            </ul>
          )}
          {remaining > 0 ? (
            <Button
              type="button"
              variant="outline"
              className={styles.more}
              onClick={() => setLimit((current) => current + TRACKS_PAGE_SIZE)}
            >
              Mostra altri {formatCount(Math.min(remaining, TRACKS_PAGE_SIZE))} (ne restano{' '}
              {formatCount(remaining)})
            </Button>
          ) : null}
        </>
      )}
    </Panel>
  );
}

/**
 * Nessun brano: solo con un elenco completo vuol dire che lo store non ne ha. Con un elenco
 * interrotto o non riuscito (Blob giù, tempo scaduto) si dice quello, non "carica i file".
 */
function TracksEmptyState({ store }: { store: AdminFeaturedRights['store'] }) {
  const icon = <Music2 className="size-6 text-muted-foreground" />;
  if (store.status === 'ok') {
    return (
      <EmptyState
        icon={icon}
        title="Nessun brano in evidenza nello store"
        description="Carica i file audio nello store Vercel Blob: compariranno qui e in Home."
      />
    );
  }
  if (store.status === 'unavailable') {
    return (
      <EmptyState
        icon={icon}
        title="Store non disponibile"
        description={store.reason ?? 'Riprova tra poco.'}
      />
    );
  }
  return (
    <EmptyState
      icon={icon}
      title="Elenco dello store non riuscito"
      description={`${store.reason ?? 'L’elenco dello store si è interrotto.'} Riprova tra qualche secondo con «Aggiorna».`}
    />
  );
}

function licenceLabel(licenza: string | null) {
  return licenza ? (LICENCE_LABELS[licenza] ?? licenza) : '—';
}

function linesText(count: number) {
  return plural(count, 'riga', 'righe');
}

function searchExplanation(
  track: FeaturedRightsTrack,
  manifestStatus: FeaturedRightsManifestStatus,
): string {
  if (track.declared) {
    return `Ricercabile: dichiarato in diritti.json (${licenceLabel(track.licenza)}, titolare ${track.titolare ?? '—'}).`;
  }
  switch (manifestStatus) {
    case 'missing':
      return 'Non ricercabile: diritti.json non c’è. In Home resta visibile.';
    case 'invalid':
      return 'Non ricercabile: diritti.json non è valido (vedi sopra). In Home resta visibile.';
    case 'unavailable':
      return 'Non so se è ricercabile: diritti.json non si legge in questo momento.';
    default:
      return 'Non ricercabile: nessuna voce valida di diritti.json indica esattamente questo percorso. In Home resta visibile.';
  }
}

/** Percorso del file di testo da affiancare al brano (stesso nome, altra estensione). */
function sidecarPath(pathname: string, extension: 'lrc' | 'txt') {
  const slash = pathname.lastIndexOf('/');
  const dot = pathname.lastIndexOf('.');
  return `${dot > slash + 1 ? pathname.slice(0, dot) : pathname}.${extension}`;
}

function lyricsExplanation(track: FeaturedRightsTrack): string | null {
  const hasSidecar = track.sidecars.lrc || track.sidecars.txt;
  if (!track.declared) {
    return hasSidecar
      ? 'C’è un file di testo accanto, ma il brano non è dichiarato: il testo non si mostra.'
      : null;
  }
  if (!track.testo) {
    if (track.testoOffBy !== null) {
      return `Testo spento: le voci di questo file in diritti.json non sono d’accordo e la voce n. ${formatCount(track.testoOffBy)} non ha "testo": true (serve in tutte le voci dello stesso file).`;
    }
    return hasSidecar
      ? 'Testo spento: c’è un file di testo accanto, ma la voce non ha "testo": true (aggiungilo solo se hai anche i diritti sul testo).'
      : 'Testo spento: la voce non ha "testo": true.';
  }
  const lyrics = track.lyrics;
  const unusable = (from: 'lrc' | 'txt' | 'embedded', sidecarError: boolean) => {
    const skippedLrc = track.sidecars.lrc && from !== 'lrc';
    const skippedTxt = track.sidecars.txt && from === 'embedded';
    if (!skippedLrc && !skippedTxt) return '';
    // Lettura fallita (rete o tempo) ≠ file inutilizzabile: il file potrebbe essere buono.
    return sidecarError
      ? ' La lettura del file di testo accanto non è riuscita (errore o tempo scaduto): per ora si usa questa fonte, si riprova da solo entro una decina di minuti.'
      : ' Il file di testo accanto non è usabile (oltre 64 KB, non UTF-8 o vuoto).';
  };
  switch (lyrics.status) {
    case 'lrc':
    case 'txt':
    case 'embedded': {
      const kind = lyrics.kind === 'synced' ? 'sincronizzato' : 'semplice';
      const from =
        lyrics.status === 'embedded'
          ? 'incorporato nel file audio'
          : `dal file .${lyrics.status} accanto`;
      return `Testo mostrato nel player: ${from}, ${kind}, ${linesText(lyrics.lineCount)}.${unusable(lyrics.status, lyrics.sidecarError === true)}`;
    }
    case 'none':
      return `Testo attivo ma non trovato: carica “${sidecarPath(track.pathname, 'lrc')}” (sincronizzato) o “${sidecarPath(track.pathname, 'txt')}” come privato, oppure incorpora il testo nei tag del file.${hasSidecar ? ' Il file di testo accanto non è usabile (oltre 64 KB, non UTF-8 o vuoto).' : ''}`;
    case 'error':
      return 'Testo attivo, ma la lettura non è riuscita (errore o tempo scaduto): «Aggiorna» la riprova.';
    case 'skipped':
      return 'Testo attivo, non ancora controllato: premi «Aggiorna» per controllarlo.';
    default:
      return null;
  }
}

function LyricsBadge({ track }: { track: FeaturedRightsTrack }) {
  if (!track.declared) return null;
  if (!track.testo) return <StatusBadge>Testo spento</StatusBadge>;
  const lyrics = track.lyrics;
  let badge: ReactNode;
  switch (lyrics.status) {
    case 'lrc':
    case 'txt':
      badge = (
        <StatusBadge tone="positive">
          Testo .{lyrics.status} · {linesText(lyrics.lineCount)}
        </StatusBadge>
      );
      break;
    case 'embedded':
      badge = (
        <StatusBadge tone="positive">Testo incorporato · {linesText(lyrics.lineCount)}</StatusBadge>
      );
      break;
    case 'none':
      badge = <StatusBadge tone="warning">Testo non trovato</StatusBadge>;
      break;
    case 'error':
      badge = <StatusBadge tone="critical">Errore di lettura</StatusBadge>;
      break;
    default:
      badge = <StatusBadge>Da controllare</StatusBadge>;
  }
  return (
    <>
      <StatusBadge tone="info">Testo attivo</StatusBadge>
      {badge}
    </>
  );
}

async function copyPath(pathname: string) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard_unavailable');
    await navigator.clipboard.writeText(pathname);
    toast.success('Percorso copiato.');
  } catch {
    toast.error('Copia non riuscita: seleziona il percorso e copialo a mano.');
  }
}

function TrackItem({
  track,
  manifestStatus,
}: {
  track: FeaturedRightsTrack;
  manifestStatus: FeaturedRightsManifestStatus;
}) {
  const titleId = useId();
  const name = track.artist ? `${track.artist} — ${track.title}` : track.title;
  const sidecars = [track.sidecars.lrc ? '.lrc' : null, track.sidecars.txt ? '.txt' : null]
    .filter(Boolean)
    .join(', ');
  const lyricsNote = lyricsExplanation(track);
  return (
    <li>
      <article className={styles.track} aria-labelledby={titleId}>
        <div className={styles.trackMain}>
          <h3 id={titleId} className={styles.trackTitle}>
            {name}
          </h3>
          <p className={styles.muted}>Sezione: {track.section}</p>
          <div className={styles.pathRow}>
            <code className={styles.path}>{track.pathname}</code>
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label={`Copia percorso di ${name}`}
              onClick={() => void copyPath(track.pathname)}
            >
              <ClipboardCopy aria-hidden="true" />
              Copia percorso
            </Button>
          </div>
        </div>
        <div className={styles.trackStatus}>
          <div className={styles.badges}>
            {track.declared ? (
              <StatusBadge tone="positive">Ricercabile</StatusBadge>
            ) : (
              <StatusBadge>Non dichiarato</StatusBadge>
            )}
            <LyricsBadge track={track} />
          </div>
          <dl className={styles.fields}>
            <div>
              <dt>Licenza</dt>
              <dd>{licenceLabel(track.licenza)}</dd>
            </div>
            <div>
              <dt>Titolare</dt>
              <dd>{track.titolare ?? '—'}</dd>
            </div>
            <div>
              <dt>File di testo accanto</dt>
              <dd>{sidecars || 'nessuno'}</dd>
            </div>
          </dl>
          <p className={styles.explanation}>{searchExplanation(track, manifestStatus)}</p>
          {lyricsNote ? <p className={styles.explanation}>{lyricsNote}</p> : null}
        </div>
      </article>
    </li>
  );
}

// @polsia:user-owned — pagina /admin/diritti-testi: diagnosi dei "brani in evidenza" (store Vercel
// Blob). Per ogni brano dice se è ricercabile (voce valida in diritti.json) e, per i brani
// dichiarati con "testo": true, se il testo c'è e da dove viene. Mostra lo stato di diritti.json
// con le voci scartate o ignorate e il perché, più una guida. Legge solo /api/admin/featured-rights.
// È una DIAGNOSI: la risposta non contiene MAI il testo dei brani e non ci sono scorciatoie per
// dichiarare brani in blocco: solo "Copia percorso" del singolo file.
//
// Trascrizione IA (Whisper): SOLO nelle schede dei brani dichiarati con "testo": true (campo
// `transcription` della risposta; gli altri brani non hanno né pulsante né altro). "Trascrivi con
// l'IA" chiede una bozza LRC a /api/admin/featured-rights/transcribe (si può annullare), la mostra
// in un editor da rivedere e "Salva come .lrc" la scrive accanto al brano (sostituendo un .lrc
// esistente solo dopo la conferma). La bozza resta in questa pagina, per questo amministratore:
// lo stato di ogni brano (richiesta in corso, bozza, modifiche) vive sopra l'elenco, così filtri e
// ricerca non lo perdono; una bozza modificata non si sostituisce senza chiedere.
'use client';

import {
  CircleX,
  ClipboardCopy,
  FileCheck2,
  LoaderCircle,
  Music2,
  RefreshCw,
  RotateCw,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useForm, useWatch } from 'react-hook-form';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch } from '@/lib/api-client';
import {
  type AdminFeaturedRights,
  AdminFeaturedRightsSchema,
  type FeaturedRightsManifest,
  type FeaturedRightsManifestStatus,
  type FeaturedRightsProblem,
  type FeaturedRightsTrack,
  type FeaturedRightsTranscription,
} from '@/lib/contracts/admin-featured-rights';
import {
  SaveLyricsResponseSchema,
  TRANSCRIPTION_LANGUAGES,
  TRANSCRIPTION_LRC_MAX_BYTES,
  TRANSCRIPTION_NOT_CONFIGURED_MESSAGE,
  type TranscribeResponse,
  TranscribeResponseSchema,
  type TranscriptionLanguage,
  WHISPER_EXTENSIONS,
  whisperLanguageCode,
} from '@/lib/contracts/lyrics-transcription';
import { applyServerErrors } from '@/lib/forms';
import { parseLyrics } from '@/lib/music/lyrics';
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
  // Trascrizioni dei brani: sopravvivono a filtri, ricerca e «Aggiorna»; l'uscita le interrompe.
  const [sessions] = useState(() => new TranscriptionSessions());
  useEffect(() => () => sessions.abortAll(), [sessions]);

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
    <TranscriptionSessionsContext.Provider value={sessions}>
      <AppSurface className="bg-transparent">
        <PageHeader
          title="Diritti e testi"
          description="Perché un brano in evidenza è (o non è) ricercabile e se il suo testo è disponibile nel player. La diagnosi non mostra mai il testo dei brani; solo per quelli dichiarati con “testo”: true puoi trascriverlo con l'IA e salvarlo come .lrc."
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
              Aggiornato alle{' '}
              <time dateTime={data.generatedAt}>{formatTime(data.generatedAt)}</time>
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
    </TranscriptionSessionsContext.Provider>
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
                  transcriptionAvailable={data.transcriptionAvailable === true}
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

// ─── Trascrizione con l'IA (solo brani dichiarati con "testo": true) ────────────────────────────

const TRANSCRIBE_ENDPOINT = '/api/admin/featured-rights/transcribe';
const SAVE_LYRICS_ENDPOINT = '/api/admin/featured-rights/transcribe/save';
const FORMAT_LIST = `${WHISPER_EXTENSIONS.slice(0, -1).join(', ')} o ${WHISPER_EXTENSIONS.at(-1)}`;
const TOO_LARGE_REASON = 'File oltre 25 MB: la trascrizione non è disponibile.';
const utf8 = new TextEncoder();

/** Nome italiano della lingua riconosciuta da Whisper ("japanese" → "giapponese"), o null. */
function detectedLanguageName(language: string | null): string | null {
  const code = whisperLanguageCode(language);
  if (!code) return null;
  try {
    return new Intl.DisplayNames('it', { type: 'language', fallback: 'none' }).of(code) ?? null;
  } catch {
    return null;
  }
}

const durationFormat = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 0 });

function formatDuration(seconds: number) {
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = String(whole % 60).padStart(2, '0');
  return `${durationFormat.format(minutes)}:${rest}`;
}

/** Messaggio di un'azione fallita: quello del server se c'è, altrimenti `fallback`. */
function actionErrorMessage(error: unknown, fallback: string): string {
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
    return ERROR_CODE_TEXT[code] ?? fallback;
  }
  return fallback;
}

function isAbort(error: unknown, signal: AbortSignal) {
  return signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
}

/** Perché il pulsante è spento (chiave mancante, formato non accettato, file oltre 25 MB), o null. */
function transcriptionBlockedReason(
  transcription: FeaturedRightsTranscription,
  available: boolean,
  pathname: string,
): string | null {
  if (!available) return TRANSCRIPTION_NOT_CONFIGURED_MESSAGE;
  if (transcription === 'unsupported_format') {
    const extension = pathname.slice(pathname.lastIndexOf('.') + 1).toLowerCase();
    return `Formato .${extension} non supportato dalla trascrizione: servono file ${FORMAT_LIST}.`;
  }
  if (transcription === 'too_large') return TOO_LARGE_REASON;
  return null;
}

type TranscriptionSession = {
  /** Lingua scelta nel menu ('' = automatica). */
  language: TranscriptionLanguage | '';
  phase: 'idle' | 'running' | 'error';
  errorMessage: string | null;
  /** Ultima bozza ricevuta (null = nessuna, o già salvata). */
  draft: TranscribeResponse | null;
  /** Cresce a ogni bozza nuova: l'editor riparte dal testo della bozza. */
  draftVersion: number;
  editorOpen: boolean;
  /** Domanda prima di sostituire una bozza modificata con una nuova trascrizione. */
  confirmReplace: boolean;
  savedNote: string | null;
  /** Richiesta in corso (per «Annulla»). */
  controller: AbortController | null;
};

const IDLE_SESSION: TranscriptionSession = {
  language: '',
  phase: 'idle',
  errorMessage: null,
  draft: null,
  draftVersion: 0,
  editorOpen: false,
  confirmReplace: false,
  savedNote: null,
  controller: null,
};

/**
 * Stato della trascrizione di OGNI brano, tenuto sopra l'elenco: filtri, ricerca e «Aggiorna»
 * smontano le schede, ma la richiesta in corso, la bozza e le modifiche nell'editor restano (la
 * chiamata a OpenAI è a pagamento). Solo l'uscita dalla pagina interrompe le richieste.
 */
class TranscriptionSessions {
  private readonly sessions = new Map<string, TranscriptionSession>();
  /** Testo dell'editor per brano: fuori dallo stato osservato perché cambia a ogni tasto. */
  private readonly texts = new Map<string, string>();
  private readonly mounted = new Map<string, number>();
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get(pathname: string): TranscriptionSession {
    return this.sessions.get(pathname) ?? IDLE_SESSION;
  }

  update(pathname: string, patch: Partial<TranscriptionSession>) {
    this.sessions.set(pathname, { ...this.get(pathname), ...patch });
    for (const listener of this.listeners) listener();
  }

  text(pathname: string): string {
    return this.texts.get(pathname) ?? '';
  }

  setText(pathname: string, value: string) {
    this.texts.set(pathname, value);
  }

  /** True se il testo nell'editor non è più quello della bozza ricevuta (modifiche dell'admin). */
  edited(pathname: string): boolean {
    const draft = this.get(pathname).draft;
    return draft !== null && this.text(pathname) !== draft.draft;
  }

  mount(pathname: string) {
    this.mounted.set(pathname, (this.mounted.get(pathname) ?? 0) + 1);
  }

  unmount(pathname: string) {
    const count = (this.mounted.get(pathname) ?? 0) - 1;
    if (count > 0) this.mounted.set(pathname, count);
    else this.mounted.delete(pathname);
  }

  /** True se la scheda del brano è visibile adesso (non nascosta da filtri o ricerca). */
  isMounted(pathname: string): boolean {
    return this.mounted.has(pathname);
  }

  /** Uscita dalla pagina: interrompe tutte le richieste, senza avvisi. */
  abortAll() {
    for (const [pathname, session] of this.sessions) {
      const controller = session.controller;
      if (!controller) continue;
      this.sessions.set(pathname, { ...session, phase: 'idle', controller: null });
      controller.abort();
    }
  }
}

const TranscriptionSessionsContext = createContext<TranscriptionSessions | null>(null);

function useTranscriptionSession(pathname: string) {
  const sessions = useContext(TranscriptionSessionsContext);
  if (!sessions) throw new Error('Stato della trascrizione mancante.');
  const snapshot = useCallback(() => sessions.get(pathname), [sessions, pathname]);
  const session = useSyncExternalStore(sessions.subscribe, snapshot, snapshot);
  return { sessions, session };
}

/**
 * Chiede la bozza e la conserva nello stato del brano, anche se nel frattempo la scheda è stata
 * nascosta da un filtro: l'editor si apre da solo solo se la scheda è visibile.
 */
async function runTranscription(
  sessions: TranscriptionSessions,
  pathname: string,
  name: string,
  language: TranscriptionLanguage | '',
) {
  const controller = new AbortController();
  sessions.update(pathname, {
    phase: 'running',
    errorMessage: null,
    savedNote: null,
    confirmReplace: false,
    controller,
  });
  try {
    const result = await apiFetch(TRANSCRIBE_ENDPOINT, {
      method: 'POST',
      body: JSON.stringify({ pathname, ...(language ? { language } : {}) }),
      schema: TranscribeResponseSchema,
      signal: controller.signal,
    });
    if (sessions.get(pathname).controller !== controller) return;
    const visible = sessions.isMounted(pathname);
    sessions.setText(pathname, result.draft);
    sessions.update(pathname, {
      phase: 'idle',
      controller: null,
      draft: result,
      draftVersion: sessions.get(pathname).draftVersion + 1,
      editorOpen: visible,
    });
    if (result.lineCount === 0) toast('Trascrizione finita, ma nessuna parola riconosciuta.');
    else if (visible) toast.success(`Bozza pronta: ${linesText(result.lineCount)}.`);
    else {
      toast.success(
        `Bozza pronta per ${name}: ${linesText(result.lineCount)}. La trovi con «Riapri la bozza» nella sua scheda.`,
      );
    }
  } catch (error) {
    if (sessions.get(pathname).controller !== controller) return;
    if (isAbort(error, controller.signal)) {
      sessions.update(pathname, { phase: 'idle', controller: null });
      toast('Trascrizione annullata.');
      return;
    }
    const message = actionErrorMessage(error, 'La trascrizione non è riuscita. Riprova.');
    sessions.update(pathname, { phase: 'error', errorMessage: message, controller: null });
    toast.error(message);
  }
}

type LrcForm = { lrc: string };

/**
 * Pulsante, avanzamento e editor della trascrizione di UN brano. Si monta SOLO per i brani con
 * `transcription` (dichiarati con "testo": true): per gli altri non esiste. Lo stato vive in
 * TranscriptionSessions, così filtri e ricerca non perdono la richiesta né la bozza.
 */
function LyricsTranscription({
  track,
  transcription,
  name,
  available,
}: {
  track: FeaturedRightsTrack;
  transcription: FeaturedRightsTranscription;
  name: string;
  available: boolean;
}) {
  const pathname = track.pathname;
  const { sessions, session } = useTranscriptionSession(pathname);
  const headingId = useId();
  const selectId = useId();
  const reasonId = useId();
  const replaceId = useId();
  const startRef = useRef<HTMLButtonElement>(null);
  const reopenRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    sessions.mount(pathname);
    return () => sessions.unmount(pathname);
  }, [sessions, pathname]);

  const blockedReason = transcriptionBlockedReason(transcription, available, pathname);
  const running = session.phase === 'running';
  const lrcPathname = sidecarPath(pathname, 'lrc');

  // Avvio da un pulsante che sparisce (es. «Sì, trascrivi di nuovo»): il fuoco va su «Annulla».
  useEffect(() => {
    if (!running) return;
    const active = document.activeElement;
    if (!active || active === document.body) cancelRef.current?.focus();
  }, [running]);

  // La domanda prima di sostituire la bozza prende il fuoco sulla scelta sicura.
  useEffect(() => {
    if (session.confirmReplace) keepRef.current?.focus();
  }, [session.confirmReplace]);

  const start = (force = false) => {
    const current = sessions.get(pathname);
    if (blockedReason || current.phase === 'running') return;
    // Una bozza modificata (e non salvata) non si sostituisce senza chiedere.
    if (!force && sessions.edited(pathname)) {
      sessions.update(pathname, { confirmReplace: true });
      return;
    }
    void runTranscription(sessions, pathname, name, current.language);
  };

  const keepDraft = () => {
    sessions.update(pathname, { confirmReplace: false });
    startRef.current?.focus();
  };

  const cancel = () => sessions.get(pathname).controller?.abort();
  const setEditorOpen = (open: boolean) => sessions.update(pathname, { editorOpen: open });

  const draft = session.draft;
  const detected = draft ? detectedLanguageName(draft.language) : null;

  return (
    <section className={styles.transcribe} aria-labelledby={headingId} aria-busy={running}>
      <h4 id={headingId} className={styles.transcribeTitle}>
        <Sparkles aria-hidden="true" />
        Trascrizione con l'IA
      </h4>
      {running ? (
        <div className={styles.progress}>
          <output aria-live="polite" className={styles.progressText}>
            <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" />
            Trascrizione in corso… può richiedere fino a un minuto
          </output>
          <Button ref={cancelRef} type="button" size="sm" variant="outline" onClick={cancel}>
            Annulla
          </Button>
        </div>
      ) : (
        <div className={styles.transcribeRow}>
          {blockedReason ? null : (
            <div className={styles.languageField}>
              <label htmlFor={selectId}>Lingua del brano</label>
              <select
                id={selectId}
                className={styles.select}
                value={session.language}
                onChange={(event) =>
                  sessions.update(pathname, {
                    language: event.target.value as TranscriptionLanguage | '',
                  })
                }
              >
                <option value="">Automatica</option>
                {TRANSCRIPTION_LANGUAGES.map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <Button
            ref={startRef}
            type="button"
            size="sm"
            onClick={() => start()}
            disabled={blockedReason !== null}
            aria-describedby={blockedReason ? reasonId : undefined}
          >
            <Sparkles aria-hidden="true" />
            Trascrivi con l'IA
          </Button>
          {draft && !session.editorOpen ? (
            <Button
              ref={reopenRef}
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setEditorOpen(true)}
            >
              Riapri la bozza
            </Button>
          ) : null}
        </div>
      )}
      {session.confirmReplace && !running ? (
        <div className={styles.warning}>
          <TriangleAlert aria-hidden="true" />
          <div className={styles.replaceBody}>
            <p id={replaceId}>
              Hai una bozza modificata: sostituirla con una nuova trascrizione? Le tue correzioni
              andrebbero perse.
            </p>
            <div className={styles.replaceActions}>
              <Button
                type="button"
                size="sm"
                aria-describedby={replaceId}
                onClick={() => start(true)}
              >
                Sì, trascrivi di nuovo
              </Button>
              <Button
                ref={keepRef}
                type="button"
                size="sm"
                variant="outline"
                aria-describedby={replaceId}
                onClick={keepDraft}
              >
                Tieni la bozza
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {blockedReason ? (
        <p id={reasonId} className={styles.muted}>
          {blockedReason}
        </p>
      ) : (
        <p className={styles.muted}>L'audio viene inviato a OpenAI solo per la trascrizione.</p>
      )}
      {session.phase === 'error' && session.errorMessage ? (
        <p role="alert" className={styles.inlineError}>
          {session.errorMessage}
        </p>
      ) : null}
      {session.savedNote ? <output className={styles.savedNote}>{session.savedNote}</output> : null}

      {draft ? (
        <Dialog open={session.editorOpen} onOpenChange={setEditorOpen}>
          <DialogContent
            className={styles.editorDialog}
            onCloseAutoFocus={(event) => {
              // Senza DialogTrigger Radix non sa dove tornare: il fuoco resta nella scheda.
              event.preventDefault();
              (reopenRef.current ?? startRef.current)?.focus();
            }}
          >
            <DialogHeader>
              <DialogTitle>Testo di {name}</DialogTitle>
              <DialogDescription>
                Bozza automatica: controlla parole e tempi prima di salvare.
              </DialogDescription>
            </DialogHeader>
            <ul className={styles.editorMeta} aria-label="Dettagli della trascrizione">
              {detected ? <li>Lingua riconosciuta: {detected}</li> : null}
              {draft.durationSeconds !== null ? (
                <li>Durata: {formatDuration(draft.durationSeconds)}</li>
              ) : null}
              {draft.droppedSegments > 0 ? (
                <li>
                  {draft.droppedSegments === 1
                    ? '1 segmento scartato'
                    : `${formatCount(draft.droppedSegments)} segmenti scartati`}{' '}
                  perché sembravano allucinazioni dell'IA (crediti dei sottotitoli o silenzio):
                  controlla che non manchi una strofa.
                </li>
              ) : null}
            </ul>
            <LyricsEditor
              key={session.draftVersion}
              sessions={sessions}
              track={track}
              lrcPathname={lrcPathname}
              onClose={() => setEditorOpen(false)}
            />
          </DialogContent>
        </Dialog>
      ) : null}
    </section>
  );
}

/**
 * Il modulo dell'editor. Il testo parte da quello conservato per il brano (la bozza o le modifiche
 * già fatte) e ogni modifica si conserva subito: chiudere l'editor o nascondere la scheda non la
 * perde.
 */
function LyricsEditor({
  sessions,
  track,
  lrcPathname,
  onClose,
}: {
  sessions: TranscriptionSessions;
  track: FeaturedRightsTrack;
  lrcPathname: string;
  onClose: () => void;
}) {
  const pathname = track.pathname;
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const form = useForm<LrcForm>({ defaultValues: { lrc: sessions.text(pathname) } });
  const lrc = useWatch({ control: form.control, name: 'lrc' });
  const parsed = useMemo(() => parseLyrics(lrc), [lrc]);

  const save = form.handleSubmit(async (values) => {
    setSaveError(null);
    if (!parseLyrics(values.lrc)) {
      form.setError('lrc', {
        type: 'manual',
        message: 'Il testo è vuoto: scrivi almeno una riga.',
      });
      return;
    }
    if (utf8.encode(values.lrc).length > TRANSCRIPTION_LRC_MAX_BYTES) {
      form.setError('lrc', {
        type: 'manual',
        message: 'Il testo supera 64 KB: accorcialo prima di salvarlo.',
      });
      return;
    }
    // C'è già un .lrc accanto: prima si chiede la conferma, poi si sostituisce.
    if (track.sidecars.lrc && !confirmOverwrite) {
      setConfirmOverwrite(true);
      return;
    }
    try {
      const saved = await apiFetch(SAVE_LYRICS_ENDPOINT, {
        method: 'POST',
        body: JSON.stringify({ pathname, lrc: values.lrc, overwrite: confirmOverwrite }),
        schema: SaveLyricsResponseSchema,
      });
      const note = `Testo salvato come “${lrcPathname}”: compare nel player entro ~${saved.visibleWithinMinutes} minuti.`;
      sessions.setText(pathname, '');
      sessions.update(pathname, { savedNote: note, editorOpen: false, draft: null });
      toast.success(note);
    } catch (error) {
      const cause = error instanceof Error ? error.cause : null;
      if (applyServerErrors(cause, form.setError)) {
        const code =
          typeof cause === 'object' && cause !== null ? (cause as { error?: unknown }).error : null;
        if (code === 'lrc_exists') setConfirmOverwrite(true);
        return;
      }
      const message = actionErrorMessage(error, 'Salvataggio non riuscito. Riprova.');
      setSaveError(message);
      toast.error(message);
    }
  });

  const submitting = form.formState.isSubmitting;

  return (
    <Form {...form}>
      <form onSubmit={save} noValidate className={styles.editorForm}>
        <FormField
          control={form.control}
          name="lrc"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Testo (.lrc)</FormLabel>
              <FormControl>
                <Textarea
                  {...field}
                  onChange={(event) => {
                    form.clearErrors('lrc');
                    sessions.setText(pathname, event.target.value);
                    field.onChange(event);
                  }}
                  rows={14}
                  spellCheck={false}
                  className={styles.lrcInput}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <output aria-live="polite" className={styles.lineCount}>
          {parsed
            ? `${parsed.lines.length === 1 ? '1 riga letta' : `${formatCount(parsed.lines.length)} righe lette`} dal player (${parsed.kind === 'synced' ? 'sincronizzato' : 'semplice'})`
            : 'Nessuna riga leggibile: il player non mostrerebbe nulla.'}
        </output>
        {confirmOverwrite ? (
          <output className={styles.warning}>
            <TriangleAlert aria-hidden="true" />
            <span>
              Accanto al brano c’è già un file .lrc: salvando sostituisci “{lrcPathname}”. Premi
              «Sostituisci il .lrc» per confermare.
            </span>
          </output>
        ) : null}
        {saveError ? (
          <p role="alert" className={styles.inlineError}>
            {saveError}
          </p>
        ) : null}
        <DialogFooter className={styles.editorActions}>
          <Button type="button" variant="outline" onClick={onClose}>
            Annulla
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting
              ? 'Salvataggio…'
              : confirmOverwrite
                ? 'Sostituisci il .lrc'
                : 'Salva come .lrc'}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}

function TrackItem({
  track,
  manifestStatus,
  transcriptionAvailable,
}: {
  track: FeaturedRightsTrack;
  manifestStatus: FeaturedRightsManifestStatus;
  transcriptionAvailable: boolean;
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
          {track.transcription ? (
            <LyricsTranscription
              track={track}
              transcription={track.transcription}
              name={name}
              available={transcriptionAvailable}
            />
          ) : null}
        </div>
      </article>
    </li>
  );
}

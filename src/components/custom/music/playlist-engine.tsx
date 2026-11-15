// @polsia:user-owned — «Crea playlist» (/crea-playlist): il modo più facile di fare una playlist.
// Tre scelte grandi (descrivila, parti da un brano o artista, scegli l'atmosfera), poi una BOZZA
// da sistemare prima di salvare (Ascolta, Su/Giù, Sostituisci, Togli, Aggiungi altri simili, nome e
// descrizione) e un solo tocco «Salva nella Libreria». La bozza resta nel sessionStorage, così un
// ricaricamento non la perde. Nessuna risoluzione YouTube in blocco: i brani "song" si cercano solo
// quando li ascolti, dallo stesso player della Libreria.
'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  ArrowDown,
  ArrowUp,
  Brain,
  CloudRain,
  Disc3,
  Dumbbell,
  Heart,
  ListMusic,
  Loader2,
  type LucideIcon,
  MessageSquareText,
  Moon,
  Palette,
  PartyPopper,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Waves,
  X,
  Zap,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import {
  collectionQueue,
  isCollectionItemCurrent,
  playCollectionItem,
} from '@/components/custom/music/collection-tracks';
import { FallbackArt } from '@/components/custom/music/fallback-art';
import { useMusicPlayer } from '@/components/custom/music/music-player';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/business/api-error-message';
import {
  addFromReserve,
  clearStoredDraft,
  clipText,
  type DraftLists,
  draftSummary,
  draftTrackKey,
  excludedTracks,
  mergeIntoReserve,
  moveTrack,
  parseSeedText,
  readStoredDraft,
  removeTrack,
  replaceTrack,
  writeStoredDraft,
} from '@/lib/business/playlist-engine';
import { type AudiusTrackSearchResult, MusicSearchResponseSchema } from '@/lib/contracts/music';
import {
  type DraftTrack,
  type EngineAiStatus,
  type EngineOrigin,
  type ExcludedTrack,
  PLAYLIST_ENGINE_ADD_STEP,
  PLAYLIST_ENGINE_COUNTS,
  PLAYLIST_ENGINE_EXAMPLES,
  PLAYLIST_ENGINE_MAX_TRACKS,
  PLAYLIST_ENGINE_NAME_MAX,
  PLAYLIST_ENGINE_PROMPT_MAX,
  PLAYLIST_ENGINE_PROMPT_MIN,
  type PlaylistEngineStatus,
  PlaylistEngineStatusSchema,
  type PlaylistSeed,
  SaveResponseSchema,
  type StoredDraft,
  type SuggestResponse,
  SuggestResponseSchema,
} from '@/lib/contracts/playlist-engine';
import { applyServerErrors } from '@/lib/forms';
import { libraryPlaylistPath } from '@/lib/music/library-links';
import {
  AUDIUS_GENRES,
  type AudiusGenre,
  type MoodIconName,
  type MoodId,
  moodCatalog,
} from '@/lib/music/moods';
import { PLAYLIST_DESCRIPTION_MAX_LENGTH } from '@/lib/music/playlist-share';
import styles from './playlist-engine.module.css';

type Mode = EngineOrigin['mode'];
type Count = (typeof PLAYLIST_ENGINE_COUNTS)[number];

const moodIcons: Record<MoodIconName, LucideIcon> = {
  Waves,
  Zap,
  Dumbbell,
  Brain,
  PartyPopper,
  CloudRain,
  Heart,
  Moon,
};

const choices: { mode: Mode; icon: LucideIcon; title: string; text: string }[] = [
  {
    mode: 'describe',
    icon: MessageSquareText,
    title: 'Descrivila con parole tue',
    text: 'Scrivi cosa vuoi ascoltare: l’AI propone i brani.',
  },
  {
    mode: 'seed',
    icon: Disc3,
    title: 'Parti da un brano o da un artista',
    text: 'Scegli da dove partire: ti propongo brani simili.',
  },
  {
    mode: 'mood',
    icon: Palette,
    title: 'Scegli l’atmosfera',
    text: 'Un tocco su un mood o un genere: funziona per tutti.',
  },
];

const SaveFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Dai un nome alla playlist.')
    .max(
      PLAYLIST_ENGINE_NAME_MAX,
      `Il nome può avere al massimo ${PLAYLIST_ENGINE_NAME_MAX} caratteri.`,
    ),
  description: z
    .string()
    .max(
      PLAYLIST_DESCRIPTION_MAX_LENGTH,
      `La descrizione può avere al massimo ${PLAYLIST_DESCRIPTION_MAX_LENGTH} caratteri.`,
    ),
});
type SaveForm = z.infer<typeof SaveFormSchema>;

/** I campi dei moduli delle tre scelte che il server può segnalare. */
const FORM_FIELDS = ['prompt', 'artist', 'title', 'mood', 'genre'] as const;

/** Il corpo dell'errore che apiFetch allega (Error.cause). */
function errorCause(error: unknown) {
  return error instanceof Error && typeof error.cause === 'object' && error.cause !== null
    ? (error.cause as { error?: unknown; message?: unknown; errors?: Record<string, unknown> })
    : null;
}

function fieldErrorsOf(cause: ReturnType<typeof errorCause>): Record<string, string> {
  const errors = cause?.errors;
  if (!errors || typeof errors !== 'object') return {};
  return Object.fromEntries(
    Object.entries(errors).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

/** Una riga sotto la bozza quando l'AI non ha partecipato pur essendo stata chiesta. */
function aiNoteFor(ai: SuggestResponse['ai']) {
  const skipped: EngineAiStatus[] = [
    'premium_required',
    'unavailable',
    'rate_limited',
    'refused',
    'busy',
    'failed',
  ];
  if (!skipped.includes(ai.status)) return null;
  return `${ai.message ?? 'L’AI non ha risposto.'} Per ora ti propongo solo brani Audius.`;
}

async function fetchSuggestions(
  origin: EngineOrigin,
  count: number,
  exclude: ExcludedTrack[] = [],
): Promise<SuggestResponse> {
  return apiFetch('/api/music/playlist-engine/suggest', {
    method: 'POST',
    body: JSON.stringify({ ...origin, count, exclude }),
    schema: SuggestResponseSchema,
  });
}

function sourceBadge(track: DraftTrack) {
  return track.source === 'audius'
    ? 'Audius · si ascolta subito'
    : 'Lo cerco su YouTube quando lo ascolti';
}

export function PlaylistEngine() {
  const router = useRouter();
  const player = useMusicPlayer();
  const id = useId();
  const [status, setStatus] = useState<PlaylistEngineStatus | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  const [count, setCount] = useState<Count>(20);

  const [prompt, setPrompt] = useState('');
  const [seedText, setSeedText] = useState('');
  const [seedResults, setSeedResults] = useState<AudiusTrackSearchResult[] | null>(null);
  const [seedChoice, setSeedChoice] = useState<string>('typed');
  const [searching, setSearching] = useState(false);
  const [mood, setMood] = useState<MoodId | null>(null);
  const [genre, setGenre] = useState<AudiusGenre | null>(null);
  const [useAi, setUseAi] = useState<boolean | null>(null);

  const [loading, setLoading] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [requestError, setRequestError] = useState<{ message: string; offerMood: boolean } | null>(
    null,
  );

  const [draft, setDraft] = useState<StoredDraft | null>(null);
  const [aiNote, setAiNote] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tracksError, setTracksError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  const restored = useRef(false);
  const persist = useRef(true);
  const draftRef = useRef<StoredDraft | null>(null);
  draftRef.current = draft;
  const draftHeading = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  const form = useForm<SaveForm>({
    resolver: zodResolver(SaveFormSchema),
    defaultValues: { name: '', description: '' },
  });

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/music/playlist-engine', { schema: PlaylistEngineStatusSchema })
      .then((value) => !cancelled && setStatus(value))
      .catch(() => !cancelled && setStatus(null));
    return () => {
      cancelled = true;
    };
  }, []);

  // Una bozza lasciata in questa scheda torna al ricaricamento (lo storage può mancare: pazienza).
  // biome-ignore lint/correctness/useExhaustiveDependencies: solo al primo montaggio.
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const stored = readStoredDraft();
    if (!stored) return;
    setDraft(stored);
    setMode(stored.origin.mode);
    form.reset({ name: stored.name, description: stored.description });
  }, []);

  useEffect(() => {
    if (draft && persist.current) writeStoredDraft(draft);
  }, [draft]);

  // Nome e descrizione digitati finiscono nella bozza salvata.
  useEffect(() => {
    const subscription = form.watch((values) => {
      setDraft((current) =>
        current
          ? { ...current, name: values.name ?? '', description: values.description ?? '' }
          : current,
      );
    });
    return () => subscription.unsubscribe();
  }, [form]);

  useEffect(() => {
    if (!pendingFocus) return;
    setPendingFocus(null);
    document.getElementById(pendingFocus)?.focus();
  }, [pendingFocus]);

  useEffect(() => {
    if (requestError) errorRef.current?.focus();
  }, [requestError]);

  const aiReady = Boolean(status?.ai && status.premium);
  const aiChecked = useAi ?? mode === 'seed';
  const trackDomId = useCallback(
    (track: Pick<DraftTrack, 'source' | 'sourceId'>, action: string) =>
      `${id}-${draftTrackKey(track).replace(/[^A-Za-z0-9_-]/g, '_')}-${action}`,
    [id],
  );

  /**
   * `focusPanel`: dai pulsanti di ripiego («Prova «Scegli l’atmosfera»»), che spariscono insieme al
   * modulo o all'avviso: il focus va al titolo del nuovo pannello, non si perde sul body.
   */
  function chooseMode(next: Mode, focusPanel = false) {
    setMode(next);
    setFieldErrors({});
    setRequestError(null);
    if (focusPanel) setPendingFocus(`${id}-panel-${next}`);
  }

  function originFromForm(): EngineOrigin | null {
    if (mode === 'describe') return { mode, prompt: prompt.trim() };
    if (mode === 'seed') {
      const picked = seedResults?.find((track) => track.id === seedChoice);
      const seed: PlaylistSeed = picked
        ? {
            artist: clipText(picked.artistName, 100),
            title: clipText(picked.title, 150),
            audius: {
              trackId: picked.id,
              genre: picked.genre?.slice(0, 60) ?? null,
              mood: picked.mood?.slice(0, 60) ?? null,
            },
          }
        : { ...parseSeedText(seedText), audius: null };
      return { mode, seed, useAi: aiReady && aiChecked };
    }
    if (mode === 'mood') return { mode, mood, genre, useAi: aiReady && aiChecked };
    return null;
  }

  async function createDraft(event: FormEvent) {
    event.preventDefault();
    const origin = originFromForm();
    if (!origin || loading) return;
    setLoading(true);
    setFieldErrors({});
    setRequestError(null);
    // Un annuncio della bozza precedente («… tolto dalla bozza») non deve tornare dopo il caricamento.
    setAnnouncement('');
    try {
      const response = await fetchSuggestions(origin, count);
      if (response.tracks.length === 0) {
        setRequestError({
          message: response.notice ?? 'Non ho trovato brani. Prova con un’altra scelta.',
          offerMood: origin.mode !== 'mood',
        });
        return;
      }
      persist.current = true;
      const next: StoredDraft = {
        version: 1,
        origin,
        name: response.name,
        description: response.description ?? '',
        tracks: response.tracks,
        reserve: response.reserve,
      };
      setDraft(next);
      setTracksError(null);
      form.reset({ name: next.name, description: next.description });
      setAiNote(aiNoteFor(response.ai));
      setNotice(response.notice);
      toast.success(`Bozza pronta: ${response.tracks.length} brani. Sistemala e salvala.`);
      requestAnimationFrame(() => draftHeading.current?.focus());
    } catch (error) {
      const cause = errorCause(error);
      const fields = fieldErrorsOf(cause);
      if (FORM_FIELDS.some((field) => fields[field])) {
        setFieldErrors(fields);
        return;
      }
      const code = typeof cause?.error === 'string' ? cause.error : '';
      setRequestError({
        message:
          fields.request ??
          (typeof cause?.message === 'string'
            ? cause.message
            : 'Non sono riuscito a preparare la bozza. Riprova.'),
        offerMood:
          origin.mode === 'describe' ||
          ['premium_required', 'not_configured', 'busy', 'failed', 'refused'].includes(code),
      });
    } finally {
      setLoading(false);
    }
  }

  async function searchSeed() {
    const query = seedText.trim();
    if (!query || searching) return;
    setSearching(true);
    try {
      const response = await apiFetch(
        `/api/music/search?source=audius&q=${encodeURIComponent(query.slice(0, 80))}`,
        { schema: MusicSearchResponseSchema },
      );
      const results = response.tracks.filter((track) => track.playbackEligible).slice(0, 6);
      setSeedResults(results);
      // Senza l'AI il testo scritto trova solo artisti presenti su Audius: si parte dal primo
      // risultato, che porta con sé il suo genere. Con l'AI resta il testo scritto.
      setSeedChoice(aiReady ? 'typed' : (results[0]?.id ?? 'typed'));
    } catch (error) {
      toast.error(apiErrorMessage(error, 'La ricerca su Audius non è riuscita. Riprova.'));
    } finally {
      setSearching(false);
    }
  }

  function updateLists(lists: DraftLists) {
    setDraft((current) =>
      current ? { ...current, tracks: lists.tracks, reserve: lists.reserve } : current,
    );
  }

  /** Altri brani per la stessa richiesta, senza ripetere quelli in bozza e nelle scorte. */
  async function fetchMore(wanted: number, lists: DraftLists): Promise<DraftLists | null> {
    const current = draftRef.current;
    if (!current) return null;
    try {
      const response = await fetchSuggestions(current.origin, wanted, excludedTracks(lists));
      return mergeIntoReserve(lists, [...response.tracks, ...response.reserve]);
    } catch (error) {
      const cause = errorCause(error);
      toast.error(
        typeof cause?.message === 'string'
          ? cause.message
          : 'Non sono riuscito a trovare altri brani. Riprova.',
      );
      return null;
    }
  }

  function move(index: number, delta: number) {
    const current = draftRef.current;
    const track = current?.tracks[index];
    if (!current || !track) return;
    const tracks = moveTrack(current.tracks, index, delta);
    updateLists({ tracks, reserve: current.reserve });
    const position = index + delta;
    setAnnouncement(`«${track.title}» spostato in posizione ${position + 1} di ${tracks.length}.`);
    const atEdge = position === 0 || position === tracks.length - 1;
    setPendingFocus(
      trackDomId(track, atEdge ? (position === 0 ? 'down' : 'up') : delta < 0 ? 'up' : 'down'),
    );
  }

  function remove(index: number) {
    const current = draftRef.current;
    const track = current?.tracks[index];
    if (!current || !track) return;
    const tracks = removeTrack(current.tracks, index);
    updateLists({ tracks, reserve: current.reserve });
    setAnnouncement(`«${track.title}» tolto dalla bozza.`);
    const next = tracks[index] ?? tracks[index - 1];
    setPendingFocus(next ? trackDomId(next, 'remove') : `${id}-add`);
  }

  async function replace(index: number) {
    const current = draftRef.current;
    const old = current?.tracks[index];
    if (!current || !old || busy) return;
    let lists: DraftLists = { tracks: current.tracks, reserve: current.reserve };
    let result = replaceTrack(lists, index);
    if (!result.replaced) {
      setBusy(true);
      const more = await fetchMore(3, lists);
      setBusy(false);
      if (!more) return;
      lists = more;
      result = replaceTrack(lists, index);
    }
    const replacement = result.tracks[index];
    if (!result.replaced || !replacement) {
      toast.error('Non ho trovato un altro brano da proporre qui.');
      return;
    }
    updateLists(result);
    setAnnouncement(`«${old.title}» sostituito con «${replacement.title}».`);
    setPendingFocus(trackDomId(replacement, 'replace'));
  }

  async function addSimilar() {
    const current = draftRef.current;
    if (!current || busy) return;
    const room = PLAYLIST_ENGINE_MAX_TRACKS - current.tracks.length;
    const wanted = Math.min(PLAYLIST_ENGINE_ADD_STEP, room);
    if (wanted <= 0) {
      toast.error(`Una bozza può avere al massimo ${PLAYLIST_ENGINE_MAX_TRACKS} brani.`);
      return;
    }
    let result = addFromReserve({ tracks: current.tracks, reserve: current.reserve }, wanted);
    if (result.added < wanted) {
      setBusy(true);
      const more = await fetchMore(wanted - result.added + 2, result);
      setBusy(false);
      if (more) {
        const extra = addFromReserve(more, wanted - result.added);
        result = { ...extra, added: result.added + extra.added };
      }
    }
    if (result.added === 0) {
      toast.error('Non ho trovato altri brani simili.');
      return;
    }
    updateLists(result);
    setTracksError(null);
    setAnnouncement(`Aggiunti ${result.added} brani in fondo alla bozza.`);
    toast.success(result.added === 1 ? 'Aggiunto 1 brano.' : `Aggiunti ${result.added} brani.`);
  }

  function startOver() {
    clearStoredDraft();
    setDraft(null);
    setAiNote(null);
    setNotice(null);
    setTracksError(null);
    setAnnouncement('');
    form.reset({ name: '', description: '' });
    setPendingFocus(`${id}-choice-${mode ?? 'describe'}`);
  }

  const save = form.handleSubmit(async (values) => {
    const current = draftRef.current;
    if (!current || saving) return;
    if (current.tracks.length === 0) {
      setTracksError('La bozza è vuota: aggiungi almeno un brano.');
      return;
    }
    setSaving(true);
    setTracksError(null);
    try {
      const response = await apiFetch('/api/music/playlist-engine/save', {
        method: 'POST',
        body: JSON.stringify({
          name: values.name,
          description: values.description.trim() ? values.description : null,
          tracks: current.tracks,
        }),
        schema: SaveResponseSchema,
      });
      persist.current = false;
      clearStoredDraft();
      toast.success(
        `«${response.name}» è nella tua Libreria con ${response.saved} brani${
          response.skipped ? ` (${response.skipped} scartati perché doppi o non più validi)` : ''
        }.`,
      );
      router.push(libraryPlaylistPath(response.collectionId));
    } catch (error) {
      const cause = errorCause(error);
      const fields = fieldErrorsOf(cause);
      const { tracks: tracksMessage, ...formFields } = fields;
      if (tracksMessage) setTracksError(tracksMessage);
      const applied = applyServerErrors({ errors: formFields }, form.setError);
      if (!applied && !tracksMessage) {
        toast.error(
          apiErrorMessage(
            error,
            typeof cause?.message === 'string'
              ? cause.message
              : 'Salvataggio non riuscito. Riprova: la bozza resta qui.',
          ),
        );
      }
    } finally {
      setSaving(false);
    }
  });

  const tracks = draft?.tracks ?? [];
  const queue = collectionQueue(tracks);
  const summary = draftSummary(tracks);
  const nameError = form.formState.errors.name?.message;
  const descriptionError = form.formState.errors.description?.message;

  const aiOption =
    mode === 'seed' || mode === 'mood' ? (
      aiReady ? (
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={aiChecked}
            onChange={(event) => setUseAi(event.target.checked)}
          />
          <span>
            Aggiungi anche brani famosi suggeriti dall’AI (Claude). Li cerco su YouTube solo quando
            li ascolti.
          </span>
        </label>
      ) : status?.ai && status.signedIn ? (
        <p className={styles.hint}>
          Con Premium l’AI aggiunge anche brani famosi simili, pure di artisti che non sono su
          Audius. <Link href="/piani">Provalo gratis per 10 giorni</Link>.
        </p>
      ) : null
    ) : null;

  const countPicker = (
    <fieldset className={styles.segmented}>
      <legend>Quanti brani?</legend>
      {PLAYLIST_ENGINE_COUNTS.map((value) => (
        <label key={value}>
          <input
            type="radio"
            name={`${id}-count`}
            value={value}
            checked={count === value}
            onChange={() => setCount(value)}
          />
          <span>{value} brani</span>
        </label>
      ))}
    </fieldset>
  );

  const submitButton = (label: string) => (
    <div className={styles.actions}>
      <Button type="submit" size="lg" aria-busy={loading} disabled={loading}>
        {loading ? (
          <Loader2 aria-hidden="true" className={styles.spin} />
        ) : (
          <Sparkles aria-hidden="true" />
        )}
        {loading ? 'Preparo la bozza…' : label}
      </Button>
    </div>
  );

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>SOLCO · CREA PLAYLIST</p>
        <h1 className={styles.title}>Crea una playlist in pochi tocchi.</h1>
        <p className={styles.lead}>
          Scegli come partire: preparo una bozza che puoi ascoltare e sistemare. Niente viene
          salvato finché non tocchi «Salva nella Libreria».
        </p>
      </header>

      {status && !status.signedIn ? (
        <p className={styles.notice}>
          <Link href="/login?callbackURL=%2Fcrea-playlist">Accedi</Link> per creare una playlist e
          salvarla nella tua Libreria.
        </p>
      ) : null}

      {draft ? null : (
        <>
          <fieldset className={styles.choices}>
            <legend>Come vuoi creare la playlist?</legend>
            {choices.map((choice) => {
              const Icon = choice.icon;
              return (
                <button
                  key={choice.mode}
                  id={`${id}-choice-${choice.mode}`}
                  type="button"
                  className={styles.choice}
                  aria-pressed={mode === choice.mode}
                  onClick={() => chooseMode(choice.mode)}
                >
                  <Icon aria-hidden="true" />
                  <span>
                    <strong>{choice.title}</strong>
                    <span>{choice.text}</span>
                  </span>
                </button>
              );
            })}
          </fieldset>

          {mode === 'describe' ? (
            <form className={styles.panel} onSubmit={(event) => void createDraft(event)} noValidate>
              <h2 id={`${id}-panel-describe`} tabIndex={-1}>
                Descrivila con parole tue
              </h2>
              {status && (!status.ai || !status.premium) ? (
                <p className={styles.notice}>
                  {!status.ai
                    ? 'Le proposte con l’AI non sono disponibili in questo momento.'
                    : 'Le proposte con l’AI sono incluse in Premium.'}{' '}
                  {status.ai && !status.premium ? (
                    <>
                      <Link href="/piani">Provalo gratis per 10 giorni</Link>, oppure{' '}
                    </>
                  ) : (
                    'Intanto puoi '
                  )}
                  <Button
                    type="button"
                    variant="link"
                    className="h-auto p-0"
                    onClick={() => chooseMode('mood', true)}
                  >
                    scegliere l’atmosfera
                  </Button>
                  : funziona per tutti.
                </p>
              ) : null}
              <div className={styles.field}>
                <label htmlFor={`${id}-prompt`}>Che playlist vuoi?</label>
                <textarea
                  id={`${id}-prompt`}
                  value={prompt}
                  rows={3}
                  maxLength={PLAYLIST_ENGINE_PROMPT_MAX}
                  placeholder="es. canzoni allegre per una cena d’estate"
                  aria-invalid={fieldErrors.prompt ? true : undefined}
                  aria-describedby={`${id}-prompt-hint${fieldErrors.prompt ? ` ${id}-prompt-error` : ''}`}
                  onChange={(event) => setPrompt(event.target.value)}
                />
                <p id={`${id}-prompt-hint`} className={styles.hint}>
                  {prompt.length}/{PLAYLIST_ENGINE_PROMPT_MAX} caratteri · il testo viene inviato ad
                  Anthropic (Claude) solo per proporre i brani. <Link href="/privacy">Privacy</Link>
                </p>
                {fieldErrors.prompt ? (
                  <p id={`${id}-prompt-error`} className={styles.error} role="alert">
                    {fieldErrors.prompt}
                  </p>
                ) : null}
              </div>
              <fieldset className={styles.chips}>
                <legend className="sr-only">Esempi</legend>
                {PLAYLIST_ENGINE_EXAMPLES.map((example) => (
                  <button
                    key={example}
                    type="button"
                    className={styles.chip}
                    onClick={() => setPrompt(example)}
                  >
                    {example}
                  </button>
                ))}
              </fieldset>
              {countPicker}
              {submitButton('Crea la bozza')}
              {prompt.trim().length > 0 && prompt.trim().length < PLAYLIST_ENGINE_PROMPT_MIN ? (
                <p className={styles.hint}>Scrivi almeno {PLAYLIST_ENGINE_PROMPT_MIN} caratteri.</p>
              ) : null}
            </form>
          ) : null}

          {mode === 'seed' ? (
            <form className={styles.panel} onSubmit={(event) => void createDraft(event)} noValidate>
              <h2 id={`${id}-panel-seed`} tabIndex={-1}>
                Parti da un brano o da un artista
              </h2>
              <div className={styles.field}>
                <label htmlFor={`${id}-seed`}>Artista o brano</label>
                <div className={styles.searchRow}>
                  <input
                    id={`${id}-seed`}
                    value={seedText}
                    maxLength={160}
                    placeholder={
                      aiReady
                        ? 'es. Lucio Dalla - Caruso'
                        : 'es. il nome di un artista o di un brano'
                    }
                    aria-invalid={fieldErrors.artist ? true : undefined}
                    aria-describedby={`${id}-seed-hint${fieldErrors.artist ? ` ${id}-seed-error` : ''}`}
                    onChange={(event) => {
                      setSeedText(event.target.value);
                      setSeedChoice('typed');
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!seedText.trim() || searching}
                    aria-busy={searching}
                    onClick={() => void searchSeed()}
                  >
                    {searching ? (
                      <Loader2 aria-hidden="true" className={styles.spin} />
                    ) : (
                      <Search aria-hidden="true" />
                    )}
                    Cerca su Audius
                  </Button>
                </div>
                <p id={`${id}-seed-hint`} className={styles.hint}>
                  {aiReady
                    ? 'Scrivi «Artista - Brano» oppure solo l’artista. Con «Cerca su Audius» puoi partire da un brano che si ascolta subito.'
                    : 'Senza l’AI parto solo da brani che sono su Audius: scrivi un artista o un brano, tocca «Cerca su Audius» e scegli un risultato.'}
                </p>
                {fieldErrors.artist || fieldErrors.title ? (
                  <p id={`${id}-seed-error`} className={styles.error} role="alert">
                    {fieldErrors.artist ?? fieldErrors.title}
                  </p>
                ) : null}
              </div>
              {seedResults ? (
                <fieldset className={styles.seedOptions}>
                  <legend>Da dove parto?</legend>
                  <label className={styles.seedOption}>
                    <input
                      type="radio"
                      name={`${id}-seed-choice`}
                      checked={seedChoice === 'typed'}
                      onChange={() => setSeedChoice('typed')}
                    />
                    <span>
                      «{seedText.trim() || '…'}» <small>come l’hai scritto</small>
                    </span>
                  </label>
                  {seedResults.map((track) => (
                    <label key={track.id} className={styles.seedOption}>
                      <input
                        type="radio"
                        name={`${id}-seed-choice`}
                        checked={seedChoice === track.id}
                        onChange={() => setSeedChoice(track.id)}
                      />
                      <span>
                        {track.title} <small>· {track.artistName} · Audius</small>
                      </span>
                    </label>
                  ))}
                  {seedResults.length === 0 ? (
                    <p className={styles.hint}>
                      Su Audius non ho trovato brani da ascoltare subito.
                    </p>
                  ) : null}
                </fieldset>
              ) : null}
              {aiOption}
              {countPicker}
              {submitButton('Crea la bozza')}
            </form>
          ) : null}

          {mode === 'mood' ? (
            <form className={styles.panel} onSubmit={(event) => void createDraft(event)} noValidate>
              <h2 id={`${id}-panel-mood`} tabIndex={-1}>
                Scegli l’atmosfera
              </h2>
              <fieldset className={styles.chips}>
                <legend>Atmosfera</legend>
                {moodCatalog.map((entry) => {
                  const Icon = moodIcons[entry.icon];
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      className={styles.chip}
                      aria-pressed={mood === entry.id}
                      title={entry.description}
                      onClick={() => setMood((current) => (current === entry.id ? null : entry.id))}
                    >
                      <Icon aria-hidden="true" />
                      {entry.label}
                    </button>
                  );
                })}
              </fieldset>
              <fieldset className={styles.chips}>
                <legend>Genere (facoltativo)</legend>
                {AUDIUS_GENRES.map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={styles.chip}
                    aria-pressed={genre === value}
                    onClick={() => setGenre((current) => (current === value ? null : value))}
                  >
                    {value}
                  </button>
                ))}
              </fieldset>
              {fieldErrors.mood || fieldErrors.genre ? (
                <p className={styles.error} role="alert">
                  {fieldErrors.mood ?? fieldErrors.genre}
                </p>
              ) : null}
              <p className={styles.hint}>
                Brani dal catalogo Audius con licenza aperta: si ascoltano subito, anche in
                background.
              </p>
              {aiOption}
              {countPicker}
              {submitButton('Crea la bozza')}
            </form>
          ) : null}

          {requestError ? (
            <p ref={errorRef} tabIndex={-1} className={styles.notice} role="alert">
              {requestError.message}{' '}
              {requestError.offerMood && mode !== 'mood' ? (
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0"
                  onClick={() => chooseMode('mood', true)}
                >
                  Prova «Scegli l’atmosfera»
                </Button>
              ) : null}
            </p>
          ) : null}
        </>
      )}

      {draft ? (
        <section className={styles.draft} aria-labelledby={`${id}-draft-title`}>
          <h2 ref={draftHeading} id={`${id}-draft-title`} tabIndex={-1}>
            La tua bozza
          </h2>
          <p className={styles.summary}>
            {summary.total === 1 ? '1 brano' : `${summary.total} brani`}
            {summary.audius ? ` · ${summary.audius} si ascoltano subito (Audius)` : ''}
            {summary.songs ? ` · ${summary.songs} li cerco su YouTube quando li ascolti` : ''}
          </p>
          {aiNote ? <p className={styles.notice}>{aiNote}</p> : null}
          {notice ? <p className={styles.notice}>{notice}</p> : null}
          {summary.songs > 0 ? (
            <p className={styles.hint}>
              I brani da cercare su YouTube si cercano uno alla volta, solo quando li ascolti: se le
              ricerche YouTube di oggi sono finite, potrai ascoltarli più tardi.
            </p>
          ) : null}

          <form className={styles.draft} onSubmit={(event) => void save(event)} noValidate>
            <div className={styles.field}>
              <label htmlFor={`${id}-name`}>Nome della playlist</label>
              <input
                id={`${id}-name`}
                maxLength={PLAYLIST_ENGINE_NAME_MAX}
                aria-invalid={nameError ? true : undefined}
                aria-describedby={nameError ? `${id}-name-error` : undefined}
                {...form.register('name')}
              />
              {nameError ? (
                <p id={`${id}-name-error`} className={styles.error} role="alert">
                  {nameError}
                </p>
              ) : null}
            </div>
            <div className={styles.field}>
              <label htmlFor={`${id}-description`}>Descrizione (facoltativa)</label>
              <textarea
                id={`${id}-description`}
                rows={2}
                maxLength={PLAYLIST_DESCRIPTION_MAX_LENGTH}
                aria-invalid={descriptionError ? true : undefined}
                aria-describedby={descriptionError ? `${id}-description-error` : undefined}
                {...form.register('description')}
              />
              {descriptionError ? (
                <p id={`${id}-description-error`} className={styles.error} role="alert">
                  {descriptionError}
                </p>
              ) : null}
            </div>

            {tracks.length === 0 ? (
              <p className={styles.notice}>
                La bozza è vuota. Tocca «Aggiungi altri simili» oppure ricomincia.
              </p>
            ) : (
              <ol className={styles.list} aria-label="Brani della bozza">
                {tracks.map((track, index) => {
                  const current = isCollectionItemCurrent(player, track);
                  const playing = current && player.status === 'playing';
                  const playable = queue.some(
                    (item) => item.qualifiedId === `${track.source}:${track.sourceId}`,
                  );
                  return (
                    <li
                      key={draftTrackKey(track)}
                      className={styles.track}
                      data-current={current || undefined}
                    >
                      <span className={styles.position} aria-hidden="true">
                        {index + 1}
                      </span>
                      <span className={styles.art}>
                        {track.source === 'audius' ? (
                          <FallbackArt src={track.artworkUrl} label={track.title} size={44} />
                        ) : (
                          <ListMusic aria-hidden="true" />
                        )}
                      </span>
                      <span className={styles.trackText}>
                        <strong>{track.title}</strong>
                        <span>{track.creatorName ?? 'Artista sconosciuto'}</span>
                        <span className={styles.badge}>{sourceBadge(track)}</span>
                      </span>
                      <span className={styles.trackActions}>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          disabled={!playable}
                          aria-pressed={current}
                          aria-label={`${playing ? 'Pausa' : 'Ascolta'} «${track.title}»`}
                          title={playing ? 'Pausa' : 'Ascolta'}
                          onClick={() => playCollectionItem(player, track, queue)}
                        >
                          {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
                        </Button>
                        <Button
                          id={trackDomId(track, 'up')}
                          type="button"
                          variant="ghost"
                          size="icon"
                          disabled={index === 0}
                          aria-label={`Sposta su «${track.title}»`}
                          title="Sposta su"
                          onClick={() => move(index, -1)}
                        >
                          <ArrowUp aria-hidden="true" />
                        </Button>
                        <Button
                          id={trackDomId(track, 'down')}
                          type="button"
                          variant="ghost"
                          size="icon"
                          disabled={index === tracks.length - 1}
                          aria-label={`Sposta giù «${track.title}»`}
                          title="Sposta giù"
                          onClick={() => move(index, 1)}
                        >
                          <ArrowDown aria-hidden="true" />
                        </Button>
                        {/* Etichette visibili: un'icona ↻ da sola non dice «sostituisci». */}
                        <Button
                          id={trackDomId(track, 'replace')}
                          type="button"
                          variant="ghost"
                          size="sm"
                          className={styles.labelled}
                          disabled={busy}
                          aria-label={`Sostituisci «${track.title}»`}
                          onClick={() => void replace(index)}
                        >
                          <RefreshCw aria-hidden="true" />
                          Sostituisci
                        </Button>
                        <Button
                          id={trackDomId(track, 'remove')}
                          type="button"
                          variant="ghost"
                          size="sm"
                          className={styles.labelled}
                          aria-label={`Togli «${track.title}»`}
                          onClick={() => remove(index)}
                        >
                          <X aria-hidden="true" />
                          Togli
                        </Button>
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}

            <div className={styles.actions}>
              <Button
                id={`${id}-add`}
                type="button"
                variant="outline"
                aria-busy={busy}
                disabled={busy || tracks.length >= PLAYLIST_ENGINE_MAX_TRACKS}
                onClick={() => void addSimilar()}
              >
                {busy ? (
                  <Loader2 aria-hidden="true" className={styles.spin} />
                ) : (
                  <Plus aria-hidden="true" />
                )}
                Aggiungi altri simili (+{PLAYLIST_ENGINE_ADD_STEP})
              </Button>
            </div>
            {tracksError ? (
              <p className={styles.error} role="alert">
                {tracksError}
              </p>
            ) : null}
            <div className={styles.actions}>
              <Button type="submit" size="lg" aria-busy={saving} disabled={saving || busy}>
                {saving ? <Loader2 aria-hidden="true" className={styles.spin} /> : null}
                {saving ? 'Salvo…' : 'Salva nella Libreria'}
              </Button>
              {/* Lontano da «Salva» e con conferma: un tocco sbagliato non butta la bozza. */}
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    className={styles.startOver}
                    disabled={saving}
                  >
                    Ricomincia
                  </Button>
                </AlertDialogTrigger>
                {/* Confermato, il pulsante sparisce con la bozza e startOver porta il focus sulle
                    tre scelte; annullato, Radix lo riporta su «Ricomincia». */}
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Vuoi buttare questa bozza?</AlertDialogTitle>
                    <AlertDialogDescription>
                      {tracks.length === 1
                        ? 'Il brano, il nome e la descrizione della bozza vanno persi. Nella Libreria non cambia niente.'
                        : `I ${tracks.length} brani, il nome e la descrizione della bozza vanno persi. Nella Libreria non cambia niente.`}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Tienila</AlertDialogCancel>
                    <AlertDialogAction onClick={startOver}>Butta la bozza</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </form>
        </section>
      ) : null}

      <output className="sr-only" aria-live="polite">
        {loading ? 'Preparo la bozza…' : announcement}
      </output>
    </main>
  );
}

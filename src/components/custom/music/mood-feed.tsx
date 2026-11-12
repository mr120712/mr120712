// @polsia:user-owned — feed della Home per un mood: brani Audius (stessa riga e stesso player delle
// altre sezioni Audius, con la nota di licenza OML), radio dal vivo, podcast e playlist Solco
// collegate. Ogni sezione ha i suoi stati di caricamento, errore e vuoto.
'use client';

import {
  ArrowLeft,
  Brain,
  ChevronDown,
  ChevronUp,
  CloudRain,
  Dumbbell,
  Heart,
  type LucideIcon,
  Moon,
  PartyPopper,
  Waves,
  Zap,
} from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { AudiusTrackList } from '@/components/custom/music/audius-section';
import { useLibrary } from '@/components/custom/music/library-context';
import { focusMoodChip, useMoodSelection } from '@/components/custom/music/mood-chips';
import { PodcastTile } from '@/components/custom/music/podcast-tile';
import { StationTile } from '@/components/custom/music/radio-station-tile';
import { apiFetch } from '@/lib/api-client';
import { FREE_MONTHLY_PLAYS } from '@/lib/business/play-quota';
import {
  type MoodFeedResponse,
  MoodFeedResponseSchema,
  type MoodSectionStatus,
} from '@/lib/contracts/moods';
import type { MoodEntry, MoodIconName } from '@/lib/music/moods';
import discover from './discover.module.css';
import styles from './mood-feed.module.css';

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

/** Brani Audius mostrati prima di "Mostra altri brani" (la coda del player resta la lista intera). */
export const MOOD_TRACKS_PREVIEW = 8;

type FeedState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'loaded'; data: MoodFeedResponse };

/** A section as the page shows it: its status and how many items are on screen. */
type AnnouncedSection = { status: MoodSectionStatus; count: number };

function sectionSummary(section: AnnouncedSection, one: string, many: string) {
  if (section.status === 'unavailable') return `${many} non disponibili`;
  return `${section.count} ${section.count === 1 ? one : many}`;
}

/** Testo per la regione aria-live: gli stessi numeri delle sezioni sullo schermo. */
export function moodAnnouncement(
  mood: Pick<MoodEntry, 'label'>,
  sections: { tracks: AnnouncedSection; stations: AnnouncedSection; podcasts: AnnouncedSection },
) {
  return `Mood ${mood.label}: ${sectionSummary(sections.tracks, 'brano', 'brani')}, ${sectionSummary(
    sections.stations,
    'radio',
    'radio',
  )} e ${sectionSummary(sections.podcasts, 'podcast', 'podcast')}.`;
}

function Block({
  title,
  eyebrow,
  link,
  busy,
  children,
}: {
  title: string;
  eyebrow?: string;
  link?: { href: string; label: string };
  busy: boolean;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section className={discover.section} aria-labelledby={headingId} aria-busy={busy}>
      <header className={styles.blockHeader}>
        <div>
          {eyebrow ? <p className={discover.eyebrow}>{eyebrow}</p> : null}
          <h3 id={headingId}>{title}</h3>
        </div>
        {link ? <Link href={link.href}>{link.label}</Link> : null}
      </header>
      {children}
    </section>
  );
}

function RowSkeleton({ label }: { label: string }) {
  return (
    <>
      <p className="sr-only">{label}</p>
      <ul className={styles.skeletonList} aria-hidden="true" data-testid="mood-skeleton">
        {[0, 1, 2, 3, 4].map((index) => (
          <li key={index} className={styles.skeletonRow}>
            <span className={`${styles.bone} ${styles.boneArt}`} />
            <span>
              <span className={`${styles.bone} ${styles.boneLine}`} />
              <span className={`${styles.bone} ${styles.boneLine} ${styles.boneShort}`} />
            </span>
            <span className={`${styles.bone} ${styles.boneButton}`} />
          </li>
        ))}
      </ul>
    </>
  );
}

function RailSkeleton({ label }: { label: string }) {
  return (
    <>
      <p className="sr-only">{label}</p>
      <div className={styles.skeletonRail} aria-hidden="true" data-testid="mood-skeleton">
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <span key={index} className={styles.skeletonTile}>
            <span className={`${styles.bone} ${styles.boneTile}`} />
            <span className={`${styles.bone} ${styles.boneLine}`} />
          </span>
        ))}
      </div>
    </>
  );
}

export function MoodFeed({
  mood,
  onBack,
  onAnnounce,
}: {
  mood: MoodEntry;
  /** "Torna a Tutto": torna al feed completo della Home. */
  onBack: () => void;
  /** Messaggio per la regione aria-live della pagina (mood caricato o errore). */
  onAnnounce?: (message: string) => void;
}) {
  const library = useLibrary();
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [state, setState] = useState<FeedState>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [tracksExpanded, setTracksExpanded] = useState(false);
  const tracksListId = useId();

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is an explicit refetch trigger.
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    apiFetch(`/api/music/moods/${encodeURIComponent(mood.id)}`, {
      schema: MoodFeedResponseSchema,
    })
      .then((data) => {
        if (!cancelled) setState({ status: 'loaded', data });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [mood.id, reloadKey]);

  const Icon = moodIcons[mood.icon];
  const loading = state.status === 'loading';
  const data = state.status === 'loaded' ? state.data : null;
  const tracks = (data?.tracks.items ?? []).filter((track) => track.playbackEligible);
  const stations = (data?.stations.items ?? []).filter(
    (station) => !library.isHidden('station', station.id),
  );
  const podcasts = (data?.podcasts.items ?? []).filter(
    (podcast) => !library.isHidden('podcast', podcast.id),
  );
  const genres = data?.genres.items ?? [];
  const shownTracks = tracksExpanded ? tracks : tracks.slice(0, MOOD_TRACKS_PREVIEW);

  // Same lists as the sections below (hidden stations and podcasts left out), so the screen
  // reader hears what is on screen.
  const announcement =
    state.status === 'loading'
      ? null
      : state.status === 'error'
        ? `Non è stato possibile caricare il mood ${mood.label}.`
        : moodAnnouncement(mood, {
            tracks: { status: state.data.tracks.status, count: tracks.length },
            stations: { status: state.data.stations.status, count: stations.length },
            podcasts: { status: state.data.podcasts.status, count: podcasts.length },
          });

  useEffect(() => {
    if (onAnnounce && announcement) onAnnounce(announcement);
  }, [announcement, onAnnounce]);

  return (
    <section className={styles.feed} aria-labelledby={headingId} data-mood={mood.id}>
      <header className={styles.header}>
        <span className={styles.icon} aria-hidden="true">
          <Icon />
        </span>
        <div className={styles.headerCopy}>
          <p className={discover.eyebrow}>MOOD</p>
          <h2 id={headingId} ref={headingRef} tabIndex={-1}>
            {mood.label}
          </h2>
          <p className={styles.description}>{mood.description}</p>
        </div>
        <button type="button" className={styles.pillButton} onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          Torna a Tutto
        </button>
      </header>

      {state.status === 'error' ? (
        <div className={styles.errorBox}>
          <p className={discover.state}>
            Non riusciamo a caricare il mood {mood.label} in questo momento.
          </p>
          <button
            type="button"
            className={styles.pillButton}
            onClick={() => {
              // The button goes away while the feed reloads: keep focus on the mood heading.
              headingRef.current?.focus();
              // Empty the live region, so a second failure (the same message) is announced again.
              onAnnounce?.('');
              setReloadKey((value) => value + 1);
            }}
          >
            Riprova
          </button>
        </div>
      ) : (
        <>
          <Block title="Brani da Audius" eyebrow="ANCHE IN BACKGROUND" busy={loading}>
            {loading ? (
              <RowSkeleton label="Caricamento dei brani…" />
            ) : data?.tracks.status === 'unavailable' ? (
              <p className={discover.state}>
                I brani Audius non sono raggiungibili in questo momento.
              </p>
            ) : tracks.length === 0 ? (
              <p className={discover.state}>Nessun brano Audius per questo mood, per ora.</p>
            ) : (
              <>
                <div id={tracksListId}>
                  {/* Every track stays in the player queue, also those not shown yet. */}
                  <AudiusTrackList tracks={shownTracks} queue={tracks} />
                </div>
                {tracks.length > MOOD_TRACKS_PREVIEW ? (
                  <button
                    type="button"
                    className={`${styles.pillButton} ${styles.moreButton}`}
                    aria-expanded={tracksExpanded}
                    aria-controls={tracksListId}
                    onClick={() => setTracksExpanded((value) => !value)}
                  >
                    {tracksExpanded ? (
                      <>
                        <ChevronUp aria-hidden="true" />
                        Mostra meno
                      </>
                    ) : (
                      <>
                        <ChevronDown aria-hidden="true" />
                        Mostra altri brani
                      </>
                    )}
                  </button>
                ) : null}
                <p className={discover.state}>
                  Brani pubblicati dagli artisti su Audius. Brani completi e anche a schermo
                  bloccato: con Free contano nei {FREE_MONTHLY_PLAYS} ascolti del mese, con Premium
                  sono illimitati.
                </p>
              </>
            )}
          </Block>

          <Block
            title="Radio dal vivo"
            eyebrow="RADIO"
            link={{ href: '/radio', label: 'Tutte le radio' }}
            busy={loading}
          >
            {loading ? (
              <RailSkeleton label="Caricamento delle radio…" />
            ) : data?.stations.status === 'unavailable' ? (
              <p className={discover.state}>Le radio non sono raggiungibili in questo momento.</p>
            ) : stations.length === 0 ? (
              <p className={discover.state}>Nessuna radio per questo mood, per ora.</p>
            ) : (
              <>
                <div className={discover.rail}>
                  {stations.map((station) => (
                    <StationTile key={station.id} station={station} queue={stations} />
                  ))}
                </div>
                <p className={discover.state}>
                  Le radio dal vivo non contano negli ascolti del piano Free.
                </p>
              </>
            )}
          </Block>

          <Block
            title="Podcast"
            eyebrow="DA ASCOLTARE"
            link={{ href: '/podcasts', label: 'Tutti i podcast' }}
            busy={loading}
          >
            {loading ? (
              <RailSkeleton label="Caricamento dei podcast…" />
            ) : data?.podcasts.status === 'unavailable' ? (
              <p className={discover.state}>I podcast non sono raggiungibili in questo momento.</p>
            ) : podcasts.length === 0 ? (
              <p className={discover.state}>Nessun podcast per questo mood, per ora.</p>
            ) : (
              <div className={discover.rail}>
                {podcasts.map((podcast) => (
                  <PodcastTile key={podcast.id} podcast={podcast} />
                ))}
              </div>
            )}
          </Block>

          {loading || genres.length > 0 ? (
            <Block
              title="Playlist Solco a tema"
              link={{ href: '/generi', label: 'Tutti i generi' }}
              busy={loading}
            >
              {loading ? (
                <p className={discover.state}>Caricamento delle playlist…</p>
              ) : (
                <ul className={styles.genreLinks}>
                  {genres.map((genre) => (
                    <li key={genre.slug}>
                      <Link href={genre.href}>{genre.name}</Link>
                    </li>
                  ))}
                </ul>
              )}
            </Block>
          ) : null}
        </>
      )}
    </section>
  );
}

/**
 * Sceglie il feed della Home: con "Tutto" (nessun ?mood) mostra `children`, il feed di sempre;
 * con un mood mostra MoodFeed. Va dentro un <Suspense> (legge useSearchParams).
 *
 * Il feed di sempre si monta la prima volta che "Tutto" è visibile e poi resta montato, solo
 * nascosto, mentre è attivo un mood: tornare a "Tutto" è immediato e ne conserva lo stato
 * (regione delle classifiche, sezioni aperte) senza rifare le richieste.
 */
export function HomeMoodSwitch({
  children,
  className,
}: {
  children: ReactNode;
  /** Classe del contenitore del feed per mood (stessa larghezza del feed della Home). */
  className?: string;
}) {
  const { selected, select } = useMoodSelection();
  const selectedId = selected?.id ?? null;
  const [announcement, setAnnouncement] = useState('');
  const previous = useRef(selectedId);
  const [defaultMounted, setDefaultMounted] = useState(selectedId === null);
  if (selectedId === null && !defaultMounted) setDefaultMounted(true);

  useEffect(() => {
    if (previous.current !== null && selectedId === null) {
      setAnnouncement('Di nuovo tutto il feed della Home.');
    }
    previous.current = selectedId;
  }, [selectedId]);

  return (
    <>
      <output className="sr-only" aria-live="polite">
        {announcement}
      </output>
      {selected ? (
        <div className={className}>
          <MoodFeed
            key={selected.id}
            mood={selected}
            onBack={() => {
              select(null);
              focusMoodChip(null);
            }}
            onAnnounce={setAnnouncement}
          />
        </div>
      ) : null}
      {defaultMounted ? (
        <div className={styles.defaultFeed} hidden={selected !== null}>
          {children}
        </div>
      ) : null}
    </>
  );
}

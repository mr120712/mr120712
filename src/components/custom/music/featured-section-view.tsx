// @polsia:user-owned — pagina «Mostra tutti» di una sezione dei "brani in evidenza" (/cartella/<id>):
// copertina a mosaico con le copertine dei suoi brani, titolo della sezione (come in Home: la
// radice dello store è «Ascolta ora» sotto «In evidenza», la stessa intestazione del link), numero
// di brani, «Riproduci tutto» e «Casuale», e l'elenco dei brani (un tocco suona il brano, con la
// coda della sezione). Mostra SOLO i brani della cartella con i diritti dichiarati in diritti.json
// (li filtra il server: GET /api/music/featured/sections/<id>), al massimo 500. La riproduzione è la
// stessa della Home (playHomeTrack: stesso elemento del player, stesso percorso di streaming, stesse
// regole). Stati: caricamento, nessun brano (404), errore con «Riprova». Ogni riga con `shareId` ha
// accanto il suo «Condividi» (link diretto /evidenza/<id>) e, se la copia offline è consentita,
// «Scarica offline»; «Scarica la cartella per offline» salva i soli brani consentiti. Elenco, coda,
// link alla Home e scheletro sono gli stessi della pagina d'artista (featured-track-list.tsx).
// La stessa pagina serve i GENERI della fila «Per genere» della Home ("genere" in diritti.json): il
// server manda `genre: true` e i soli brani dichiarati con quel genere. Un account Free vede i 30
// brani più recenti («30 di N brani») con l'invito a Premium per gli altri (featured-plan).
'use client';

import { FolderOpen, Play, RotateCcw, Shuffle } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  FeaturedBackLink,
  FeaturedListSkeleton,
  FeaturedOfflineDownload,
  FeaturedPremiumMore,
  FeaturedTrackList,
  featuredListCount,
  featuredLoadFailure,
  playFeaturedQueue,
} from '@/components/custom/music/featured-track-list';
import { useMusicPlayer } from '@/components/custom/music/music-player';
import { PlaylistMosaic } from '@/components/custom/music/playlist-mosaic';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { serverLimitMessage } from '@/lib/business/api-error-message';
import {
  type FeaturedSectionResponse,
  FeaturedSectionResponseSchema,
  featuredSectionApiPath,
} from '@/lib/contracts/featured-sections';
import { shuffledCopy } from '@/lib/music/featured-artists';
import { FEATURED_ROOT_SECTION_HEADING, isFeaturedSectionId } from '@/lib/music/featured-sections';
import artistStyles from './featured-artist-view.module.css';
import sectionStyles from './featured-section-view.module.css';

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; data: FeaturedSectionResponse }
  /** Nessun brano dichiarato in questa sezione (o link non valido). */
  | { status: 'empty' }
  /** message: il testo del server per un limite raggiunto (429), se c'è. */
  | { status: 'error'; message: string | null };

/** Le classi della pagina: quelle della pagina d'artista più la copertina quadrata. */
const PAGE_CLASS = `${artistStyles.page} ${sectionStyles.page}`;

export function FeaturedSectionView({ sectionId }: { sectionId: string }) {
  const player = useMusicPlayer();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  // «Riprova» smonta lo stato d'errore: quando arriva il nuovo stato, il titolo prende il focus.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusHeadingOnLoad = useRef(false);

  useEffect(() => {
    if (state.status === 'loading' || !focusHeadingOnLoad.current) return;
    focusHeadingOnLoad.current = false;
    headingRef.current?.focus();
  }, [state.status]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt è il trigger di «Riprova».
  useEffect(() => {
    if (!isFeaturedSectionId(sectionId)) {
      setState({ status: 'empty' });
      return;
    }
    let active = true;
    setState({ status: 'loading' });
    apiFetch(featuredSectionApiPath(sectionId), { schema: FeaturedSectionResponseSchema })
      .then((data) => {
        if (!active) return;
        setState(data.tracks.length > 0 ? { status: 'ready', data } : { status: 'empty' });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState(
          featuredLoadFailure(error) === 'gone'
            ? { status: 'empty' }
            : { status: 'error', message: serverLimitMessage(error) },
        );
      });
    return () => {
      active = false;
    };
  }, [sectionId, attempt]);

  if (state.status === 'loading') {
    return <FeaturedListSkeleton label="Caricamento dei brani…" className={sectionStyles.page} />;
  }

  if (state.status === 'empty') {
    return (
      <main className={PAGE_CLASS}>
        <FeaturedBackLink />
        <section className={artistStyles.state}>
          <FolderOpen aria-hidden="true" />
          <h1 ref={headingRef} tabIndex={-1}>
            Nessun brano disponibile
          </h1>
          <p>
            In questa sezione non ci sono brani in evidenza da ascoltare su Solco, oppure il link
            non è completo. In Home trovi tutti i brani in evidenza.
          </p>
          <Button asChild>
            <Link href="/">Vai alla Home</Link>
          </Button>
        </section>
      </main>
    );
  }

  if (state.status === 'error') {
    return (
      <main className={PAGE_CLASS}>
        <FeaturedBackLink />
        <section className={artistStyles.state} role="alert">
          <FolderOpen aria-hidden="true" />
          <h1 ref={headingRef} tabIndex={-1}>
            Non riesco a caricare i brani
          </h1>
          <p>{state.message ?? 'Controlla la connessione e riprova tra qualche istante.'}</p>
          <Button
            type="button"
            onClick={() => {
              focusHeadingOnLoad.current = true;
              setAttempt((value) => value + 1);
            }}
          >
            <RotateCcw aria-hidden="true" /> Riprova
          </Button>
        </section>
      </main>
    );
  }

  const { section, tracks, total } = state.data;
  // La radice ha in Home l'intestazione «Ascolta ora» sotto «In evidenza»: la pagina la ripete,
  // così il titolo è quello del link toccato (e «In evidenza» non compare due volte).
  const isRoot = section.root === true;
  const isGenre = !isRoot && section.genre === true;
  const heading = isRoot ? FEATURED_ROOT_SECTION_HEADING : section.title;
  const eyebrow = isRoot
    ? 'In evidenza'
    : isGenre
      ? 'Genere · In evidenza'
      : 'Sezione · In evidenza';

  return (
    <main className={PAGE_CLASS}>
      <FeaturedBackLink />
      <header className={artistStyles.hero}>
        {/* Le copertine dei suoi brani (dal più recente); senza copertine, l'iniziale del titolo. */}
        <div className={artistStyles.heroCover}>
          <PlaylistMosaic name={heading} items={tracks} />
        </div>
        <div className={artistStyles.heroCopy}>
          <p className={artistStyles.eyebrow}>{eyebrow}</p>
          <h1 ref={headingRef} tabIndex={-1}>
            <bdi>{heading}</bdi>
          </h1>
          <p className={artistStyles.count}>{featuredListCount(tracks.length, total)}</p>
          <div className={artistStyles.actions}>
            <Button type="button" onClick={() => playFeaturedQueue(player, tracks)}>
              <Play aria-hidden="true" /> Riproduci tutto
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={tracks.length < 2}
              onClick={() => playFeaturedQueue(player, shuffledCopy(tracks))}
            >
              <Shuffle aria-hidden="true" /> Casuale
            </Button>
          </div>
        </div>
      </header>

      {/* Solo i brani con la copia offline consentita; gli altri restano «solo streaming». */}
      <FeaturedOfflineDownload
        tracks={tracks}
        label={heading}
        scope={isGenre ? 'questo genere' : 'questa cartella'}
        actionLabel={isGenre ? 'Scarica i brani per offline' : 'Scarica la cartella per offline'}
      />

      <FeaturedTrackList
        player={player}
        tracks={tracks}
        fallbackArtist="Solco"
        headingId="section-tracks-heading"
      />

      {/* Account Free con più di 30 brani dichiarati: gli altri con Premium. */}
      <FeaturedPremiumMore
        shown={tracks.length}
        total={total}
        scope={isGenre ? 'questo genere' : 'questa cartella'}
      />
    </main>
  );
}

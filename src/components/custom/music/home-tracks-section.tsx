// @polsia:user-owned — "In evidenza" in Home: i file audio messi dall'amministratore direttamente
// nello store Vercel Blob (dal pannello), divisi in sezioni (una per cartella) e mostrati con la
// loro copertina. Riproducibili con il player; la coda è la sezione toccata. Si nasconde del tutto
// se non ce ne sono (nessun ingombro in Home). Il nome dell'artista porta alla sua pagina
// (/artista/<slug>) solo quando il server manda `artistSlug`, cioè se l'artista ha almeno un brano
// con i diritti dichiarati: nessun link a una pagina vuota. Un brano DICHIARATO (il server manda
// `shareId`) ha anche il pulsante «Condividi» (link diretto /evidenza/<id>) sopra la copertina,
// fuori dal pulsante che lo suona; gli altri nessun pulsante.
//
// Aggiornamento automatico (nessun webhook avvisa dei file caricati dal pannello Blob): la sezione
// chiede al server solo la VERSIONE del catalogo (/api/music/home-tracks/version, in cache sulla
// CDN) ogni ~30 secondi mentre la scheda è visibile, e al ritorno sulla scheda; riscarica l'elenco
// (/api/music/home-tracks?v=<versione>, in cache sulla CDN per versione) SOLO quando la versione
// cambia. Mai richieste con la scheda in background, mai query-string per aggirare la cache: il
// numero di ascoltatori non moltiplica le letture dello store. Se la versione non risponde si torna
// all'elenco senza versione, più di rado. L'aggiornamento non smonta la sezione (niente sfarfallio
// né salti di scorrimento) e non tocca la coda né il brano in riproduzione.
//
// Robustezza: ogni richiesta si interrompe dopo ~10 secondi (una connessione bloccata non ferma
// per sempre gli aggiornamenti della scheda); mai indietro a una versione più vecchia (`listedAt`:
// due istanze del server possono essere sfasate per qualche secondo e la CDN servire ora l'una ora
// l'altra); un elenco vuoto e non definitivo (store non leggibile su un'istanza) non nasconde i
// brani già mostrati.
'use client';

import { Pause, Play } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FallbackArt } from '@/components/custom/music/fallback-art';
import { FeaturedShareButton } from '@/components/custom/music/featured-share-button';
import { playHomeTrack } from '@/components/custom/music/live-tracks';
import { useMusicPlayer } from '@/components/custom/music/music-player';
import { apiFetch } from '@/lib/api-client';
import {
  HOME_TRACKS_DEFAULT_SECTION,
  type HomeTrack,
  type HomeTrackSection,
  HomeTracksResponseSchema,
  type HomeTracksVersion,
  HomeTracksVersionSchema,
} from '@/lib/contracts/home-tracks';
import { featuredArtistPath } from '@/lib/music/featured-artists';
import styles from './home-tracks-section.module.css';

const LISTING_ENDPOINT = '/api/music/home-tracks';
const VERSION_ENDPOINT = '/api/music/home-tracks/version';
/** Controllo della versione mentre la scheda è aperta e visibile. */
const VERSION_POLL_MS = 30_000;
/** Intervallo minimo tra due controlli (focus + visibilitychange insieme, anti-martellamento). */
const REFRESH_THROTTLE_MS = 15_000;
/** Versione non disponibile: si torna all'elenco senza versione, al massimo ogni 2 minuti. */
const FALLBACK_REFRESH_MS = 120_000;
/** Attesa massima di una richiesta: oltre si interrompe e il controllo successivo riprova. */
export const HOME_TRACKS_REQUEST_TIMEOUT_MS = 10_000;
/** «Condividi» sopra la copertina: tondo, scuro e leggibile su qualsiasi immagine. */
const OVERLAY_SHARE_BUTTON =
  'size-8 rounded-full bg-black/55 text-white shadow-md backdrop-blur-sm hover:bg-black/75 hover:text-white focus-visible:ring-2 focus-visible:ring-white';

/** Sezioni dalla risposta; un server meno recente manda solo `items`: una sezione unica. */
function sectionsFrom(response: {
  items: HomeTrack[];
  sections?: HomeTrackSection[];
}): HomeTrackSection[] {
  const withItems = (response.sections ?? []).filter((section) => section.items.length > 0);
  if (withItems.length > 0) return withItems;
  return response.items.length > 0
    ? [{ id: '', title: HOME_TRACKS_DEFAULT_SECTION, items: response.items }]
    : [];
}

/** Stesso contenuto (stessi brani, link e ordine): si tiene l'array attuale, niente nuovo render. */
function sameSections(a: readonly HomeTrackSection[], b: readonly HomeTrackSection[]): boolean {
  return a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
}

/** Un segnale che interrompe la richiesta dopo `ms` (setTimeout: va anche sui browser meno recenti). */
function requestDeadline(ms: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

/** `listedAt` in millisecondi; null se assente (server meno recenti) o non leggibile. */
function listedTime(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function HomeTracksSection() {
  const player = useMusicPlayer();
  const [sections, setSections] = useState<HomeTrackSection[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  /** Inizio dell'ultimo controllo (versione o, in riserva, elenco). */
  const lastCheckRef = useRef(0);
  /** La versione del contenuto mostrato (null = nessuno, o non definitivo: si richiede). */
  const shownVersionRef = useRef<string | null>(null);
  /** Il più recente `listedAt` (ms) del contenuto mostrato: mai indietro a un elenco più vecchio. */
  const shownListedAtRef = useRef(0);
  /** Quante sezioni ci sono a schermo (per non nasconderle con un elenco degradato). */
  const shownCountRef = useRef(0);
  /** true = l'ultima richiesta della versione è fallita: si va più piano, senza versione. */
  const versionFailedRef = useRef(false);
  const busyRef = useRef(false);
  const mountedRef = useRef(false);

  // Non mette mai in stato 'loading': un aggiornamento in background non deve nascondere la sezione.
  // `vouchedAt` = il `listedAt` della versione che ha chiesto questo elenco.
  const loadListing = useCallback(async (version: string | null, vouchedAt: number | null) => {
    const url = version ? `${LISTING_ENDPOINT}?v=${encodeURIComponent(version)}` : LISTING_ENDPOINT;
    const deadline = requestDeadline(HOME_TRACKS_REQUEST_TIMEOUT_MS);
    try {
      const response = await apiFetch(url, {
        schema: HomeTracksResponseSchema,
        signal: deadline.signal,
      });
      if (!mountedRef.current) return;
      const listedAt = listedTime(response.listedAt);
      // L'elenco della versione chiesta vale sempre (la versione è già risultata più recente); un
      // altro (riserva senza versione, o un'istanza con un'altra versione) solo se non è più vecchio
      // di quello mostrato: si riprova al controllo successivo.
      const asked = version !== null && response.version === version;
      if (!asked && listedAt !== null && listedAt < shownListedAtRef.current) return;
      const next = sectionsFrom(response as { items: HomeTrack[]; sections?: HomeTrackSection[] });
      // Vuoto e non definitivo (store non leggibile su quell'istanza): i brani a schermo restano e
      // si richiede al prossimo controllo. Una rimozione vera di tutti i brani arriva con `version`.
      if (next.length === 0 && response.version === undefined && shownCountRef.current > 0) {
        shownVersionRef.current = null;
        return;
      }
      shownCountRef.current = next.length;
      setSections((current) => (sameSections(current, next) ? current : next));
      // Il server manda `version` solo per un contenuto definitivo: senza, si richiede al prossimo
      // controllo (es. link d'artista non ancora pronti).
      shownVersionRef.current = response.version ?? null;
      shownListedAtRef.current = Math.max(
        shownListedAtRef.current,
        listedAt ?? 0,
        asked ? (vouchedAt ?? 0) : 0,
      );
      setState('ready');
    } catch {
      if (!mountedRef.current) return;
      setState((current) => (current === 'loading' ? 'error' : current));
    } finally {
      deadline.done();
    }
  }, []);

  const check = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    // Segna il momento SUBITO (prima dell'await): così due eventi ravvicinati (focus +
    // visibilitychange al ritorno sulla scheda) non fanno partire due controlli — il secondo cade
    // dentro la finestra di throttle.
    lastCheckRef.current = Date.now();
    try {
      let latest: HomeTracksVersion | null = null;
      const deadline = requestDeadline(HOME_TRACKS_REQUEST_TIMEOUT_MS);
      try {
        latest = await apiFetch(VERSION_ENDPOINT, {
          schema: HomeTracksVersionSchema,
          signal: deadline.signal,
        });
      } catch {
        latest = null;
      } finally {
        deadline.done();
      }
      if (!mountedRef.current) return;
      if (latest === null) {
        // Riserva: l'elenco senza versione (in cache sulla CDN ~1 minuto), come prima ma più di rado.
        versionFailedRef.current = true;
        await loadListing(null, null);
        return;
      }
      versionFailedRef.current = false;
      const listedAt = listedTime(latest.listedAt);
      // Un'istanza rimasta indietro (elenco più vecchio di quello mostrato): mai tornare a una
      // versione precedente; la prossima risposta della CDN sarà quella giusta.
      if (listedAt !== null && listedAt < shownListedAtRef.current) return;
      if (latest.version === shownVersionRef.current) {
        shownListedAtRef.current = Math.max(shownListedAtRef.current, listedAt ?? 0);
        return;
      }
      await loadListing(latest.version, listedAt);
    } finally {
      busyRef.current = false;
    }
  }, [loadListing]);

  // Primo caricamento (versione, poi l'elenco di quella versione) e aggiornamento automatico: ogni
  // volta che carichi un file nel pannello Vercel (altra scheda) e torni su Solco, o mentre resti
  // sulla pagina, la versione cambia e l'elenco si aggiorna da solo. Trigger: ritorno di focus /
  // scheda di nuovo visibile, più un controllo ogni 30 secondi SOLO a scheda visibile.
  useEffect(() => {
    mountedRef.current = true;
    void check();
    const refresh = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      const gap = versionFailedRef.current ? FALLBACK_REFRESH_MS : REFRESH_THROTTLE_MS;
      if (Date.now() - lastCheckRef.current < gap) return;
      void check();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisible);
    const interval = setInterval(refresh, VERSION_POLL_MS);
    return () => {
      mountedRef.current = false;
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(interval);
    };
  }, [check]);

  // Stesso avvio della ricerca globale (playHomeTrack). La coda è la sezione: si ascolta la
  // cartella, dal brano toccato in poi.
  const play = (item: HomeTrack, section: HomeTrackSection) =>
    playHomeTrack(player, item, section.items);

  // Si nasconde finché carica, in errore o se vuota: nessun ingombro in Home.
  if (state !== 'ready' || sections.length === 0) return null;

  return (
    <>
      {sections.map((section, index) => {
        const headingId = index === 0 ? 'in-evidenza-heading' : `in-evidenza-heading-${index}`;
        // La radice dello store (id ''), non un titolo: una cartella chiamata "In evidenza" resta sé.
        const isDefault = section.id === '';
        return (
          <section
            key={section.id || '__root'}
            id={index === 0 ? 'in-evidenza' : undefined}
            className={styles.section}
            aria-labelledby={headingId}
          >
            <div className={styles.head}>
              <p className={styles.eyebrow}>{isDefault ? 'IN EVIDENZA' : 'IN EVIDENZA · SOLCO'}</p>
              <h2 id={headingId} className={styles.title}>
                {isDefault ? 'Ascolta ora' : section.title}
              </h2>
            </div>
            <ul className={styles.rail}>
              {section.items.map((item) => {
                const qualifiedId = `upload:${item.id}`;
                const isCurrent = player.currentTrack?.qualifiedId === qualifiedId;
                const playing = isCurrent && player.status === 'playing';
                const byline = item.artist ?? 'Solco';
                return (
                  <li key={item.id} className={styles.card} data-current={isCurrent || undefined}>
                    <button
                      type="button"
                      className={styles.cardButton}
                      onClick={() => play(item, section)}
                      aria-label={
                        playing
                          ? `Metti in pausa ${item.title} di ${byline}`
                          : `Riproduci ${item.title} di ${byline}`
                      }
                      aria-pressed={isCurrent ? playing : undefined}
                    >
                      <span className={styles.art}>
                        <FallbackArt src={item.artworkUrl} label={item.title} size={160} />
                        <span className={styles.playBadge} aria-hidden="true">
                          {playing ? <Pause /> : <Play />}
                        </span>
                      </span>
                      <strong className={styles.cardTitle} title={item.title}>
                        {item.title}
                      </strong>
                      {/* Senza pagina d'artista il nome resta DENTRO il pulsante, come prima: anche
                          un tocco sul nome fa partire il brano (area di tocco intera su mobile). */}
                      {item.artistSlug ? null : <span className={styles.meta}>{byline}</span>}
                    </button>
                    {/* Con la pagina d'artista il nome è un link, quindi fuori dal pulsante (un link
                        non va dentro un pulsante). */}
                    {item.artistSlug ? (
                      <Link
                        href={featuredArtistPath(item.artistSlug)}
                        className={`${styles.meta} ${styles.artistLink}`}
                        title={`Pagina di ${byline}`}
                      >
                        {byline}
                      </Link>
                    ) : null}
                    {/* Solo per i brani dichiarati: sopra la copertina, ma fuori dal pulsante. */}
                    <FeaturedShareButton
                      track={item}
                      className={styles.share}
                      buttonClassName={OVERLAY_SHARE_BUTTON}
                    />
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </>
  );
}

// @polsia:user-owned — anteprima social (JPEG 1200×630) del link diretto di un brano in evidenza
// (/evidenza/<shareId>): è l'immagine che WhatsApp, Telegram, X e Facebook mostrano sotto il link
// (og:image di evidenza/[shareId]/page.tsx). Scheda «ASCOLTA SU SOLCO» con titolo, artista e
// copertina, costruita SOLO dai dati verificati dell'indice dei brani DICHIARATI in diritti.json
// (featured-search.server): nulla arriva dal link oltre all'id. La copertina è quella del brano
// dichiarato, letta dal server dallo store (immagine anche privata o copertina incorporata, vedi
// home-track-cover.server) e passata dagli stessi limiti di loadOgCover (byte, pixel, JPEG).
// - Id malformato, sconosciuto o di un brano non dichiarato: 404 (no-store).
// - Qualsiasi query string: 308 verso l'indirizzo senza query (una sola voce nella CDN).
// - Limite per IP «share.og» che non blocca mai se il limitatore non risponde (fail open).
// - Scheda completa: un'ora sulla CDN (più un'ora stale-while-revalidate); indice non leggibile,
//   copertina attesa ma non arrivata o disegno ripiegato: no-store (i crawler conservano la prima
//   immagine che ricevono).
// - REVOCA: l'origine risponde 404 dalla ricostruzione successiva dell'indice (~5 minuti), ma il
//   404 (no-store) non cancella la copia già sulla CDN: la scheda del brano revocato (solo titolo,
//   artista e copertina, mai l'audio) può restare servita fino a ~2 ore. Le app social ne tengono
//   comunque una copia propria. Per toglierla prima: purge della CDN.
// Mai indicizzata (X-Robots-Tag).
import { brandVisual, siteName } from '@/lib/brand';
import { consumeRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import type { HomeTrack } from '@/lib/contracts/home-tracks';
import { env } from '@/lib/env';
import { artInitial } from '@/lib/music/art-initial';
import { getFeaturedShare } from '@/lib/music/featured-search.server';
import {
  featuredShareArtist,
  featuredShareImagePath,
  featuredShareTitle,
  isFeaturedShareId,
} from '@/lib/music/featured-share';
import {
  type HomeCoverRead,
  homeCoverSourceFromArtworkUrl,
  loadHomeCoverThumbnail,
} from '@/lib/music/home-track-cover.server';
import { ogCardResponse, ogCoverFromBytes } from '@/lib/og-card.server';

export const dynamic = 'force-dynamic';

const COVER_BOX = 420;
const COVER_INNER = COVER_BOX - 2;
const TEXT_WIDTH = 1200 - 72 * 2 - COVER_BOX - 56;
/** Tempo massimo dell'indice (va ricostruito di rado): oltre, scheda generica non in cache. */
const INDEX_DEADLINE_MS = 6_000;
/** Tempo massimo di ogni lettura della copertina e dell'intera copertina. */
const COVER_READ_TIMEOUT_MS = 4_000;
const COVER_DEADLINE_MS = 6_000;

const robotsHeaders = { 'X-Robots-Tag': 'noindex, nofollow' };
// Stesso indirizzo = stessa immagine, ma per poco: un'ora sulla CDN più un'ora servibile mentre si
// rinnova, così un brano tolto da diritti.json smette di mostrare la sua anteprima entro ~2 ore
// (le piattaforme social tengono comunque la copia che hanno già scaricato).
const imageHeaders = {
  'Cache-Control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=3600',
  ...robotsHeaders,
};
const noStoreHeaders = { 'Cache-Control': 'no-store', ...robotsHeaders };
const redirectHeaders = {
  'Cache-Control': 'public, max-age=3600, s-maxage=86400',
  ...robotsHeaders,
};

type CardModel =
  | { kind: 'track'; title: string; artist: string | null; cover: string | null }
  | { kind: 'generic' };

function clip(text: string, max: number) {
  const chars = Array.from(text.trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

function Card({ model }: { model: CardModel }) {
  const { background, foreground } = brandVisual.og;
  const muted = 'rgba(250, 250, 250, 0.62)';
  const title = model.kind === 'track' ? clip(model.title, 68) : 'Musica su Solco';
  const artist = model.kind === 'track' ? model.artist : null;
  const cover = model.kind === 'track' ? model.cover : null;
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 56,
        padding: '0 72px',
        background,
        backgroundImage:
          'radial-gradient(circle at 0% 0%, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0) 55%)',
        color: foreground,
      }}
    >
      <div
        style={{
          width: COVER_BOX,
          height: COVER_BOX,
          display: 'flex',
          flexShrink: 0,
          overflow: 'hidden',
          borderRadius: 32,
          background: 'rgba(255, 255, 255, 0.08)',
          border: '1px solid rgba(255, 255, 255, 0.16)',
        }}
      >
        {cover ? (
          // biome-ignore lint/performance/noImgElement: next/og renders plain <img>.
          <img
            src={cover}
            alt=""
            width={COVER_INNER}
            height={COVER_INNER}
            style={{ objectFit: 'cover' }}
          />
        ) : (
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 200,
              fontWeight: 700,
              letterSpacing: '-0.06em',
            }}
          >
            {artInitial(title)}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', width: TEXT_WIDTH }}>
        <div
          style={{
            display: 'flex',
            fontSize: 24,
            fontWeight: 700,
            letterSpacing: '0.18em',
            color: muted,
          }}
        >
          ASCOLTA SU SOLCO
        </div>
        <div
          style={{
            display: 'block',
            width: TEXT_WIDTH,
            marginTop: 20,
            fontSize: title.length > 40 ? 52 : 68,
            fontWeight: 700,
            letterSpacing: '-0.03em',
            lineHeight: 1.05,
            wordBreak: 'break-word',
            overflow: 'hidden',
            lineClamp: 3,
          }}
        >
          {title}
        </div>
        {artist ? (
          <div
            style={{
              display: 'block',
              width: TEXT_WIDTH,
              marginTop: 24,
              fontSize: 32,
              color: muted,
              wordBreak: 'break-word',
              overflow: 'hidden',
              lineClamp: 2,
            }}
          >
            {clip(artist, 60)}
          </div>
        ) : null}
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 16,
            marginTop: 48,
            fontSize: 30,
          }}
        >
          <span style={{ fontWeight: 700 }}>{siteName}</span>
          {brandVisual.og.tagline ? (
            <span style={{ color: muted, fontSize: 24 }}>{brandVisual.og.tagline}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Il valore della promessa entro `ms`, altrimenti `fallback` (anche in errore). */
function withDeadline<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise.catch(() => fallback), deadline]).finally(() => clearTimeout(timer));
}

/**
 * Secondi di attesa se questo indirizzo ha chiesto davvero troppe anteprime. Un indirizzo assente
 * o un limitatore che non risponde non bloccano mai l'immagine (fail open).
 */
async function retryAfter(request: Request): Promise<number | null> {
  const identity = getRateLimitIdentity(null, request.headers);
  if (!identity) return null;
  try {
    const decision = await consumeRateLimit('share.og', identity);
    return !decision.allowed && decision.status === 429 ? decision.retryAfterSeconds : null;
  } catch {
    return null;
  }
}

/**
 * La copertina del brano DICHIARATO (mai da un URL del link) come data URL per next/og, e se la
 * scheda può restare in cache: sì senza copertina (stabile) o con la copertina arrivata; no se
 * era attesa ma la lettura è fallita o scaduta.
 */
async function declaredCover(
  track: HomeTrack,
): Promise<{ cover: string | null; complete: boolean }> {
  const source = homeCoverSourceFromArtworkUrl(track.artworkUrl);
  if (!source) return { cover: null, complete: true };
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) return { cover: null, complete: false };
  const read = await withDeadline<HomeCoverRead>(
    loadHomeCoverThumbnail(source, token, { timeoutMs: COVER_READ_TIMEOUT_MS }),
    COVER_DEADLINE_MS,
    { status: 'error' },
  );
  if (read.status === 'missing') return { cover: null, complete: true };
  if (read.status !== 'found') return { cover: null, complete: false };
  const cover = await ogCoverFromBytes(read.data, COVER_INNER, {
    background: brandVisual.og.background,
  });
  return { cover, complete: Boolean(cover) };
}

/** Prima la scheda voluta, poi versioni più semplici se il disegno fallisce (mai in cache). */
function fallbacks(model: CardModel): CardModel[] {
  if (model.kind === 'track' && model.cover) {
    return [model, { ...model, cover: null }, { kind: 'generic' }];
  }
  return model.kind === 'generic' ? [model] : [model, { kind: 'generic' }];
}

export async function GET(request: Request, { params }: { params: Promise<{ shareId: string }> }) {
  const { shareId } = await params;
  // Un id malformato non è mai condiviso: nessuna lettura, nessun disegno.
  if (!isFeaturedShareId(shareId))
    return new Response(null, { status: 404, headers: noStoreHeaders });

  // Ogni query string sarebbe una voce a sé nella CDN (e un disegno in più): un solo indirizzo.
  // Location relativa: dietro il proxy della piattaforma request.url può avere l'host interno.
  if (new URL(request.url).search) {
    return new Response(null, {
      status: 308,
      headers: { Location: featuredShareImagePath(shareId), ...redirectHeaders },
    });
  }

  const wait = await retryAfter(request);
  if (wait !== null) {
    const seconds = wait === 1 ? '1 secondo' : `${wait} secondi`;
    return new Response(`Troppe richieste di anteprime. Riprova tra ${seconds}.`, {
      status: 429,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Retry-After': String(wait),
        ...noStoreHeaders,
      },
    });
  }

  const lookup = await withDeadline(getFeaturedShare(shareId), INDEX_DEADLINE_MS, {
    outcome: 'unavailable' as const,
  });
  // Id sconosciuto o brano non (più) dichiarato: il link non esiste.
  if (lookup.outcome === 'not_found') {
    return new Response(null, { status: 404, headers: noStoreHeaders });
  }

  let model: CardModel = { kind: 'generic' };
  let cacheable = false;
  if (lookup.outcome === 'found') {
    const { cover, complete } = await declaredCover(lookup.track);
    model = {
      kind: 'track',
      title: featuredShareTitle(lookup.track.title),
      artist: featuredShareArtist(lookup.track.artist),
      cover,
    };
    cacheable = complete;
  }

  for (const [index, attempt] of fallbacks(model).entries()) {
    try {
      return await ogCardResponse(
        <Card model={attempt} />,
        cacheable && index === 0 ? imageHeaders : noStoreHeaders,
      );
    } catch {
      // prova la scheda successiva, più semplice
    }
  }
  return new Response(null, { status: 503, headers: noStoreHeaders });
}

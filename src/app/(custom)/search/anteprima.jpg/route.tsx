// @polsia:user-owned — anteprima social (JPEG 1200×630) di un brano condiviso dal player: è
// l'immagine che WhatsApp, Telegram, X e Facebook mostrano sotto il link (og:image della pagina
// /search, vedi search/page.tsx). Nessun URL di immagine arriva dal link:
// - ?au=<id>: brano Audius letto dal server (audius-share-card.server): copertina, titolo e
//   artista solo da Audius, scheda «ASCOLTA SU SOLCO»;
// - ?t=…&a=…: testo libero del link, presentato come una ricerca («CERCA SU SOLCO», titolo tra
//   virgolette, iniziale al posto della copertina) e ripulito da indirizzi web;
// - senza parametri: la scheda generica di Solco.
// Un solo indirizzo per scheda: parametri in più, in un altro ordine, con testo non pulito o con
// segmenti vuoti ("t=A&", solo dove l'URL arriva grezzo: vedi hasEmptySegments) ricevono un 308
// verso l'indirizzo canonico (songPreviewImagePath),
// confrontando i parametri decodificati, mai la codifica (i crawler la cambiano e si girerebbe in
// tondo). Titolo e artista Audius passano dallo stesso filtro degli indirizzi web. Stesso indirizzo
// = stessa immagine: un giorno sulla CDN. Una lettura Audius non riuscita, una copertina che non
// arriva o un disegno ripiegato non vanno mai in cache (i crawler conservano la prima immagine).
import { brandVisual, siteName } from '@/lib/brand';
import { consumeRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import {
  searchParamsRecord,
  sharedSongFromParams,
  songPreviewImagePath,
} from '@/lib/business/social-share';
import { artInitial } from '@/lib/music/art-initial';
import { getAudiusShareCard, getAudiusShareCover } from '@/lib/music/audius-share-card.server';
import { ogCardResponse } from '@/lib/og-card.server';

export const dynamic = 'force-dynamic';

const COVER_BOX = 420;
const COVER_INNER = COVER_BOX - 2;
const TEXT_WIDTH = 1200 - 72 * 2 - COVER_BOX - 56;
const robotsHeaders = { 'X-Robots-Tag': 'noindex, nofollow' };
// Stesso indirizzo = stessa immagine: un giorno sulla CDN, una settimana servibile mentre si rinnova.
const imageHeaders = {
  'Cache-Control': 'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800',
  ...robotsHeaders,
};
const noStoreHeaders = { 'Cache-Control': 'no-store', ...robotsHeaders };
const redirectHeaders = {
  'Cache-Control': 'public, max-age=3600, s-maxage=86400',
  ...robotsHeaders,
};

/**
 * - verified: brano letto da Audius (copertina facoltativa: senza, l'iniziale);
 * - search: testo del link, mostrato come una ricerca;
 * - generic: nessun testo libero.
 */
type CardModel =
  | { kind: 'verified'; title: string; artist: string; cover: string | null }
  | { kind: 'search'; title: string; artist: string | null }
  | { kind: 'generic' };

function clip(text: string, max: number) {
  const chars = Array.from(text.trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

function Card({ model }: { model: CardModel }) {
  const { background, foreground } = brandVisual.og;
  const muted = 'rgba(250, 250, 250, 0.62)';
  const plainTitle = model.kind === 'generic' ? 'Musica su Solco' : clip(model.title, 68);
  const title = model.kind === 'search' ? `«${plainTitle}»` : plainTitle;
  const artist = model.kind === 'generic' ? null : model.artist;
  const cover = model.kind === 'verified' ? model.cover : null;
  const label = model.kind === 'search' ? 'CERCA SU SOLCO' : 'ASCOLTA SU SOLCO';
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
            {artInitial(plainTitle)}
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
          {label}
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

/** Secondi di attesa se questo indirizzo ha chiesto davvero troppe anteprime (fail open). */
async function retryAfter(identity: string | null): Promise<number | null> {
  if (!identity) return null;
  try {
    const decision = await consumeRateLimit('share.og', identity);
    return !decision.allowed && decision.status === 429 ? decision.retryAfterSeconds : null;
  } catch {
    return null;
  }
}

/** Stessi parametri decodificati, nello stesso ordine (la codifica percentuale non conta). */
function sameParams(left: URLSearchParams, right: URLSearchParams) {
  const a = [...left];
  const b = [...right];
  return (
    a.length === b.length &&
    a.every(([key, value], index) => {
      const other = b[index];
      return other !== undefined && other[0] === key && other[1] === value;
    })
  );
}

/**
 * La query grezza ha segmenti vuoti ("t=A&", "&t=A", "t=A&&b", o un "?" da solo): URLSearchParams
 * li ignora, ma per la CDN sono indirizzi diversi. Nessun crawler li produce partendo dal canonico,
 * quindi reindirizzarli non può girare in tondo.
 * LIMITE (verificato con `next start`): il server Node di Next ricostruisce request.url dalla
 * query già letta prima di chiamare questa rotta (dal suo codice, lo stesso vale per il proxy
 * senza skipProxyUrlNormalize), quindi i segmenti vuoti e le varianti di codifica (`+`, `%74`)
 * qui non arrivano: quegli indirizzi ricevono la scheda in cache come il canonico. Il controllo
 * resta per i runtime che passano l'URL grezzo. Il costo resta sotto il limite per IP «share.og»:
 * il testo libero di t= dà comunque indirizzi canonici sempre nuovi, quindi le varianti non
 * permettono disegni in più.
 */
function hasEmptySegments(url: URL) {
  const href = url.href.split('#')[0] ?? '';
  const start = href.indexOf('?');
  if (start < 0) return false;
  const raw = href.slice(start + 1);
  return raw === '' || raw.split('&').some((segment) => segment === '');
}

/** La scheda da disegnare e se, disegnata per intero, può restare in cache. */
async function cardModel(
  song: ReturnType<typeof sharedSongFromParams>,
  identity: string | null,
): Promise<{ model: CardModel; cacheable: boolean }> {
  if (!song) return { model: { kind: 'generic' }, cacheable: true };
  if (!song.audiusId) {
    return {
      model: { kind: 'search', title: song.title, artist: song.artist },
      cacheable: true,
    };
  }
  // L'indirizzo canonico con un id Audius non porta testo: se Audius non risponde, scheda generica.
  // Titolo e artista arrivano già ripuliti dagli indirizzi web (audius-share-card.server).
  const track = await getAudiusShareCard(song.audiusId, { identity });
  if (!track) return { model: { kind: 'generic' }, cacheable: false };
  const cover = track.coverUrl
    ? await getAudiusShareCover(track.coverUrl, COVER_INNER, brandVisual.og.background)
    : null;
  return {
    model: { kind: 'verified', title: track.title, artist: track.artist, cover },
    // Copertina attesa ma non arrivata: la scheda va bene, ma non deve restare in cache.
    cacheable: Boolean(cover) || !track.coverUrl,
  };
}

/** Prima la scheda voluta, poi versioni più semplici se il disegno fallisce (mai in cache). */
function fallbacks(model: CardModel): CardModel[] {
  if (model.kind === 'verified' && model.cover) {
    return [model, { ...model, cover: null }, { kind: 'generic' }];
  }
  return model.kind === 'generic' ? [model] : [model, { kind: 'generic' }];
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const song = sharedSongFromParams(searchParamsRecord(url.searchParams));
  // Un solo indirizzo per scheda (una voce nella CDN, un solo disegno). Location relativa: dietro
  // il proxy della piattaforma request.url può avere l'host interno.
  const canonical = songPreviewImagePath(song);
  const canonicalQuery = canonical.includes('?') ? canonical.slice(canonical.indexOf('?') + 1) : '';
  if (hasEmptySegments(url) || !sameParams(url.searchParams, new URLSearchParams(canonicalQuery))) {
    return new Response(null, {
      status: 308,
      headers: { Location: canonical, ...redirectHeaders },
    });
  }

  const identity = getRateLimitIdentity(null, request.headers);
  const wait = await retryAfter(identity);
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

  const { model, cacheable } = await cardModel(song, identity);
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

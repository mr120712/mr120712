// @polsia:user-owned — anteprima social (JPEG 1200×630) di un quiz musicale condiviso: è l'immagine
// che WhatsApp, Telegram, X e Facebook mostrano sotto il link (og:image della pagina /quiz, vedi
// quiz/page.tsx). Una flashcard sullo sfondo del marchio: «QUIZ MUSICALE · SOLCO», «Chi
// interpreta», il titolo tra « », un grande «?» e «Gira la carta su Solco». L'ARTISTA NON SI
// DISEGNA MAI (è la risposta) e nessun URL di immagine arriva dal link:
// - ?au=<id>: brano Audius letto dal server (audius-share-card.server), titolo e copertina solo da
//   Audius; la copertina può riportare il nome dell'artista: molto sfocata e coperta dal «?»;
// - ?t=<titolo>: testo libero del link, ripulito da indirizzi web, «?» al posto della copertina;
// - senza parametri: la scheda generica «Quiz musicale su Solco».
// Stessa difesa della scheda dei brani (search/anteprima.jpg): limite per IP «share.og» (fail
// open), un solo indirizzo per scheda (308 verso quizPreviewImagePath confrontando i parametri
// decodificati; i segmenti vuoti solo dove l'URL arriva grezzo, vedi hasEmptySegments), un giorno
// sulla CDN per una scheda completa e mai in cache una lettura Audius non riuscita, una copertina
// che non arriva o un disegno ripiegato.
import { brandVisual } from '@/lib/brand';
import { consumeRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { searchParamsRecord } from '@/lib/business/social-share';
import {
  QUIZ_GENERIC_TITLE,
  quizImageFromParams,
  quizPreviewImagePath,
} from '@/lib/business/song-quiz';
import { getAudiusShareCard, getAudiusShareCover } from '@/lib/music/audius-share-card.server';
import { ogCardResponse } from '@/lib/og-card.server';

export const dynamic = 'force-dynamic';

const CARD_MARGIN = 64;
const CARD_PADDING = 48;
const COVER_BOX = 360;
const COVER_INNER = COVER_BOX - 2;
const TEXT_WIDTH = 1200 - CARD_MARGIN * 2 - CARD_PADDING * 2 - COVER_BOX - 48;
/** Sfocatura della copertina (sigma di sharp): nessuna scritta resta leggibile. */
const COVER_BLUR = 28;
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
 * - verified: brano letto da Audius (copertina sfocata facoltativa);
 * - text: titolo del link;
 * - generic: nessun brano.
 * Nessun modello porta l'artista.
 */
type CardModel =
  | { kind: 'verified'; title: string; cover: string | null }
  | { kind: 'text'; title: string }
  | { kind: 'generic' };

function clip(text: string, max: number) {
  const chars = Array.from(text.trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

function QuestionMark({ size }: { size: number }) {
  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size,
        fontWeight: 700,
        color: '#ffffff',
      }}
    >
      ?
    </div>
  );
}

function Card({ model }: { model: CardModel }) {
  const { background, foreground } = brandVisual.og;
  const muted = 'rgba(250, 250, 250, 0.62)';
  const cover = model.kind === 'verified' ? model.cover : null;
  const title = model.kind === 'generic' ? QUIZ_GENERIC_TITLE : `«${clip(model.title, 60)}»?`;
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background,
        backgroundImage:
          'radial-gradient(circle at 0% 0%, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0) 55%)',
        color: foreground,
      }}
    >
      <div
        style={{
          width: 1200 - CARD_MARGIN * 2,
          height: 630 - CARD_MARGIN * 2,
          display: 'flex',
          alignItems: 'center',
          gap: 48,
          padding: CARD_PADDING,
          borderRadius: 40,
          border: '2px solid rgba(255, 255, 255, 0.18)',
          backgroundImage:
            'linear-gradient(150deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.04) 100%)',
        }}
      >
        <div
          style={{
            position: 'relative',
            width: COVER_BOX,
            height: COVER_BOX,
            display: 'flex',
            flexShrink: 0,
            overflow: 'hidden',
            borderRadius: 28,
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
          ) : null}
          {cover ? (
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                display: 'flex',
                background: 'rgba(0, 0, 0, 0.45)',
              }}
            />
          ) : null}
          <QuestionMark size={240} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', width: TEXT_WIDTH }}>
          <div
            style={{
              display: 'flex',
              fontSize: 22,
              fontWeight: 700,
              letterSpacing: '0.18em',
              color: muted,
            }}
          >
            QUIZ MUSICALE · SOLCO
          </div>
          {model.kind === 'generic' ? null : (
            <div style={{ display: 'flex', marginTop: 24, fontSize: 36, color: muted }}>
              Chi interpreta
            </div>
          )}
          <div
            style={{
              display: 'block',
              width: TEXT_WIDTH,
              marginTop: model.kind === 'generic' ? 24 : 8,
              fontSize: title.length > 36 ? 46 : 60,
              fontWeight: 700,
              letterSpacing: '-0.03em',
              lineHeight: 1.08,
              wordBreak: 'break-word',
              overflow: 'hidden',
              lineClamp: 3,
            }}
          >
            {title}
          </div>
          <div style={{ display: 'flex', marginTop: 36 }}>
            <div
              style={{
                display: 'flex',
                padding: '12px 24px',
                borderRadius: 999,
                background: 'rgba(255, 255, 255, 0.14)',
                fontSize: 26,
                fontWeight: 700,
              }}
            >
              Gira la carta su Solco
            </div>
          </div>
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
  quiz: ReturnType<typeof quizImageFromParams>,
  identity: string | null,
): Promise<{ model: CardModel; cacheable: boolean }> {
  if (!quiz) return { model: { kind: 'generic' }, cacheable: true };
  if (!quiz.audiusId) return { model: { kind: 'text', title: quiz.title }, cacheable: true };
  // L'indirizzo canonico con un id Audius non porta testo: se Audius non risponde, scheda generica.
  // Il titolo arriva già ripulito dagli indirizzi web (audius-share-card.server); l'artista no:
  // non si usa.
  const track = await getAudiusShareCard(quiz.audiusId, { identity });
  if (!track) return { model: { kind: 'generic' }, cacheable: false };
  const cover = track.coverUrl
    ? await getAudiusShareCover(track.coverUrl, COVER_INNER, brandVisual.og.background, {
        blur: COVER_BLUR,
      })
    : null;
  return {
    model: { kind: 'verified', title: track.title, cover },
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
  const quiz = quizImageFromParams(searchParamsRecord(url.searchParams));
  // Un solo indirizzo per scheda (una voce nella CDN, un solo disegno). Location relativa: dietro
  // il proxy della piattaforma request.url può avere l'host interno.
  const canonical = quizPreviewImagePath(quiz);
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

  const { model, cacheable } = await cardModel(quiz, identity);
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

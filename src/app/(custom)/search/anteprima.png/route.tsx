// @polsia:user-owned — anteprima social (PNG 1200×630) di un brano condiviso dal player: copertina,
// titolo, artista e Solco. È l'immagine che WhatsApp, Telegram, X e Facebook mostrano sotto il link
// (og:image della pagina /search?q=…&t=…&a=…&img=…, vedi search/page.tsx).
// Copertine solo da Audius (shareable-cover): mai miniature YouTube, che le piattaforme social
// conserverebbero senza scadenza. Scaricate con ssrfSafeFetch (solo HTTPS pubblico, DNS fissato,
// niente reindirizzamenti). Senza copertina: scheda tipografica con l'iniziale. Il contenuto dipende
// solo dall'indirizzo, quindi la CDN può tenerla a lungo; una copertina che non arriva o un disegno
// ripiegato non vanno mai in cache (i crawler conservano la prima immagine che ricevono).
import { ImageResponse } from 'next/og';
import type { ReactElement } from 'react';
import { brandVisual, siteName } from '@/lib/brand';
import { consumeRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { type SharedSongCard, sharedSongFromParams } from '@/lib/business/social-share';
import { artInitial } from '@/lib/music/art-initial';
import { ssrfSafeFetch } from '@/lib/net/ssrf-safe-fetch.server';
import { loadOgBackground } from '@/lib/og-image';

export const dynamic = 'force-dynamic';

const size = { width: 1200, height: 630 };
const COVER_BOX = 420;
const TEXT_WIDTH = 1200 - 72 * 2 - COVER_BOX - 56;
const COVER_TIMEOUT_MS = 3_000;
const MAX_COVER_BYTES = 2 * 1024 * 1024;
const robotsHeaders = { 'X-Robots-Tag': 'noindex, nofollow' };
// Stesso indirizzo = stessa immagine: un giorno sulla CDN, una settimana servibile mentre si rinnova.
const imageHeaders = {
  'Cache-Control': 'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800',
  ...robotsHeaders,
};
const noStoreHeaders = { 'Cache-Control': 'no-store', ...robotsHeaders };

const coverFetch: typeof fetch = async (input, init) => {
  const response = await ssrfSafeFetch(input, {
    ...init,
    signal: AbortSignal.timeout(COVER_TIMEOUT_MS),
  });
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_COVER_BYTES) {
    return new Response(null, { status: 413 });
  }
  return response;
};

function clip(text: string, max: number) {
  const chars = Array.from(text.trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

type Drawn = { song: SharedSongCard | null; coverData: string | null };

function Card({ song, coverData }: Drawn) {
  const { background, foreground } = brandVisual.og;
  const title = song ? clip(song.title, 70) : 'Musica su Solco';
  const muted = 'rgba(250, 250, 250, 0.62)';
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
        {coverData ? (
          // biome-ignore lint/performance/noImgElement: next/og renders plain <img>.
          <img
            src={coverData}
            alt=""
            width={COVER_BOX - 2}
            height={COVER_BOX - 2}
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
        {song?.artist ? (
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
            {clip(song.artist, 60)}
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

/** Disegna subito il PNG (non in streaming), così un errore di disegno può ancora ripiegare. */
async function render(node: ReactElement, headers: Record<string, string>) {
  const image = new ImageResponse(node, { ...size, headers });
  const body = await image.arrayBuffer();
  return new Response(body, { headers: { 'Content-Type': 'image/png', ...headers } });
}

/** Secondi di attesa se questo indirizzo ha chiesto davvero troppe anteprime (fail open). */
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

export async function GET(request: Request) {
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

  const params = Object.fromEntries(new URL(request.url).searchParams.entries());
  const song = sharedSongFromParams(params);
  const coverData = song?.cover ? await loadOgBackground(song.cover, coverFetch) : null;
  // Copertina chiesta ma non arrivata: la scheda va bene, ma non deve restare in cache.
  const complete = !song?.cover || Boolean(coverData);

  const attempts: Drawn[] = coverData
    ? [
        { song, coverData },
        { song, coverData: null },
        { song: null, coverData: null },
      ]
    : [
        { song, coverData: null },
        { song: null, coverData: null },
      ];
  for (const [index, attempt] of attempts.entries()) {
    try {
      return await render(
        <Card {...attempt} />,
        complete && index === 0 ? imageHeaders : noStoreHeaders,
      );
    } catch {
      // prova la scheda successiva, più semplice
    }
  }
  return new Response(null, { status: 503, headers: noStoreHeaders });
}

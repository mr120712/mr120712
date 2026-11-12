// @polsia:user-owned — anteprima social (PNG 1200×630) di una playlist condivisa: nome, prima
// parola del nome del proprietario e fino a 4 copertine Audius. Mai miniature YouTube: le
// piattaforme social conservano l'immagine senza scadenza, i dati della YouTube API restano meno
// di 30 giorni. Un solo indirizzo (le query string vengono reindirizzate), un limite per IP che
// non blocca mai se il limitatore non risponde e una cache CDN breve: un link che smette di essere
// condiviso smette di mostrare l'anteprima entro circa 5 minuti. Se la playlist non è condivisa,
// le copertine non arrivano o il disegno fallisce, risponde con una scheda tipografica; un errore
// di lettura o un disegno ripiegato per un'eccezione non vanno mai in cache (no-store), perché i
// crawler dei link conservano la prima immagine che ricevono. Mai indicizzata (X-Robots-Tag).
// Server-only by nature (a route handler); its data modules carry the 'server-only' marker.
import { ImageResponse } from 'next/og';
import type { ReactElement } from 'react';
import { brandVisual, siteName } from '@/lib/brand';
import { consumeRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { artInitial } from '@/lib/music/art-initial';
import { isShareId, sharedPlaylistImagePath } from '@/lib/music/playlist-share';
import { getSharedPlaylist, sharedPlaylistCovers } from '@/lib/music/shared-playlists.server';
import { ssrfSafeFetch } from '@/lib/net/ssrf-safe-fetch.server';
import { loadOgBackground } from '@/lib/og-image';

export const dynamic = 'force-dynamic';

const size = { width: 1200, height: 630 };
const contentType = 'image/png';
const COVER_BOX = 420;
const COVER_BORDER = 1;
/** Inside the 1px border: two 210px tiles would not fit on one row and the grid would wrap. */
const COVER_INNER = COVER_BOX - COVER_BORDER * 2;
/** Card width minus side padding, cover block and gap. */
const TEXT_WIDTH = 1200 - 72 * 2 - COVER_BOX - 56;
const COVER_TIMEOUT_MS = 3_000;
const MAX_COVER_BYTES = 2 * 1024 * 1024;
// Never in image search, even when the PNG is found through a public post.
const robotsHeaders = { 'X-Robots-Tag': 'noindex, nofollow' };
// 60 s fresh on the CDN plus 240 s stale while it revalidates: a playlist that stops being
// shared stops showing its preview within ~5 minutes. Browsers always ask again.
const imageHeaders = {
  'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=240',
  ...robotsHeaders,
};
// Errors and degraded cards: link-preview crawlers keep the first image they get for days.
const noStoreHeaders = { 'Cache-Control': 'no-store', ...robotsHeaders };

/**
 * Covers come only from Audius (sharedPlaylistCovers); no big files. Il fetch passa da
 * ssrfSafeFetch (solo HTTPS pubblico, DNS pinnato, nessun reindirizzamento seguito): anche se
 * l'allowlist delle copertine venisse aggirata, non si può raggiungere un indirizzo interno.
 */
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

function songCount(count: number) {
  return count === 1 ? '1 brano' : `${count} brani`;
}

type CardData = { name: string; owner: string; itemCount: number; covers: string[] } | null;
/** `failed`: the read itself failed (database down, timeout), which is not "not shared". */
type CardLookup = { data: CardData; failed: boolean };

function Card({ data }: { data: CardData }) {
  const { background, foreground } = brandVisual.og;
  const name = data ? clip(data.name, 70) : 'Playlist condivisa';
  const covers = data?.covers ?? [];
  const grid = covers.length >= 4 ? covers.slice(0, 4) : covers.slice(0, 1);
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
          flexWrap: 'wrap',
          flexShrink: 0,
          overflow: 'hidden',
          borderRadius: 32,
          background: 'rgba(255, 255, 255, 0.08)',
          border: `${COVER_BORDER}px solid rgba(255, 255, 255, 0.16)`,
        }}
      >
        {grid.length > 0 ? (
          grid.map((src) => (
            // biome-ignore lint/performance/noImgElement: next/og renders plain <img>.
            <img
              key={src}
              src={src}
              alt=""
              width={grid.length === 4 ? COVER_INNER / 2 : COVER_INNER}
              height={grid.length === 4 ? COVER_INNER / 2 : COVER_INNER}
              style={{ objectFit: 'cover' }}
            />
          ))
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
            {artInitial(name)}
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
          PLAYLIST CONDIVISA
        </div>
        {/* A long name without spaces breaks inside the word; at most 3 lines, then "…". */}
        <div
          style={{
            display: 'block',
            width: TEXT_WIDTH,
            marginTop: 20,
            fontSize: name.length > 40 ? 52 : 68,
            fontWeight: 700,
            letterSpacing: '-0.03em',
            lineHeight: 1.05,
            wordBreak: 'break-word',
            overflow: 'hidden',
            lineClamp: 3,
          }}
        >
          {name}
        </div>
        {data ? (
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
            {`di ${clip(data.owner, 30)} · ${songCount(data.itemCount)}`}
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

/** Draws the PNG now (not while streaming), so a drawing error can still fall back. */
async function render(node: ReactElement, headers: Record<string, string>) {
  const image = new ImageResponse(node, { ...size, headers });
  const body = await image.arrayBuffer();
  return new Response(body, { headers: { 'Content-Type': contentType, ...headers } });
}

async function cardData(shareId: string): Promise<CardLookup> {
  try {
    const playlist = await getSharedPlaylist(shareId);
    if (!playlist) return { data: null, failed: false };
    const loaded = await Promise.all(
      sharedPlaylistCovers(playlist.items).map((src) => loadOgBackground(src, coverFetch)),
    );
    return {
      data: {
        name: playlist.name,
        owner: playlist.owner,
        itemCount: playlist.itemCount,
        covers: loaded.filter((src): src is string => Boolean(src)),
      },
      failed: false,
    };
  } catch {
    return { data: null, failed: true };
  }
}

/**
 * Seconds to wait when this address really asked for too many previews. A missing address or a
 * limiter that does not answer never blocks the image (fail open): the CDN cache is the first
 * line of defence, this only stops a loop that keeps missing it.
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

export async function GET(request: Request, { params }: { params: Promise<{ shareId: string }> }) {
  const { shareId } = await params;
  // A malformed id is never shared: no database read, no drawing.
  if (!isShareId(shareId)) return new Response(null, { status: 404, headers: noStoreHeaders });

  // Each query string would be a separate CDN entry (and a fresh drawing): one canonical address.
  // Relative Location: behind the platform proxy request.url may carry the internal host.
  if (new URL(request.url).search) {
    return new Response(null, {
      status: 308,
      headers: {
        Location: sharedPlaylistImagePath(shareId),
        'Cache-Control': 'public, max-age=3600, s-maxage=86400',
        ...robotsHeaders,
      },
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

  const { data, failed } = await cardData(shareId);
  // Full card, then without covers, then the typographic card. Only the card that was meant to be
  // drawn goes in the public cache: after a read error, or once a drawing had to fall back, the
  // answer is no-store so a short blip never sticks to the link's preview.
  const attempts: CardData[] = data ? [data, { ...data, covers: [] }, null] : [null];
  for (const [index, attempt] of attempts.entries()) {
    try {
      return await render(
        <Card data={attempt} />,
        !failed && index === 0 ? imageHeaders : noStoreHeaders,
      );
    } catch {
      // try the next, simpler card
    }
  }
  return new Response(null, { status: 503, headers: noStoreHeaders });
}

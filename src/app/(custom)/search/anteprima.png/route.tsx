// @polsia:user-owned — vecchio indirizzo (PNG) dell'anteprima social di un brano condiviso: i
// link già pubblicati e le anteprime già in cache dei social puntano ancora qui. Non disegna
// nulla: reindirizza (308) alla scheda JPEG (search/anteprima.jpg) con la stessa query, che la
// nuova rotta riporta poi alla forma canonica. Un vecchio parametro img viene così scartato.
// Location relativa (dietro il proxy request.url può avere l'host interno); in cache sulla CDN.

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  const { search } = new URL(request.url);
  return new Response(null, {
    status: 308,
    headers: {
      Location: `/search/anteprima.jpg${search}`,
      'Cache-Control': 'public, max-age=3600, s-maxage=86400',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

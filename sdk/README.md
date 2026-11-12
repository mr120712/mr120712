# @solco/sdk

Client **tipizzato** per l'API di [Solco](https://solcomusic.vercel.app): musica
(Home, tendenze, ricerca per fonte e ricerca unificata, mood, classifiche YouTube),
radio, podcast, stato del servizio, conteggio ascolti, URL di streaming e download
offline "scarica il permesso".

Funziona **nel browser** e **lato server** (Node ≥ 18, Bun, Deno). Nessuna
dipendenza a runtime: i tipi sono di sola compilazione e rispecchiano i contratti
del backend (`src/lib/contracts/*`), così un cambio di forma dell'API diventa un
errore di `tsc` invece di un bug silenzioso.

> Cartella isolata, accanto a `flutter/` e `ios/`. Non fa parte della build del
> sito (Next scansiona solo `src/` e `tests/`). Pacchetto a sé: ha il suo
> `package.json` e il suo `tsconfig`.

## Installazione

Finché non è pubblicato su un registry, si usa come dipendenza locale o si copia
la cartella `sdk/`:

```bash
cd sdk
npm install        # solo devDependency: typescript + @types/node
npm run build      # genera dist/ (ESM + .d.ts)
npm test           # type-check + unit test (node:test, senza rete)
```

## Avvio rapido

```ts
import { SolcoClient } from '@solco/sdk';

const solco = new SolcoClient(); // default: https://solcomusic.vercel.app

// Scoperta
const home = await solco.music.home();
const trending = await solco.music.trending();

// Ricerca unificata (Audius + radio + podcast; YouTube solo col consenso)
const r = await solco.music.searchAll({ q: 'nina zilli', youtube: true });
for (const item of r.results) {
  if (item.kind === 'audius') console.log(item.track.title, item.track.artistName);
}

// URL di streaming (nel browser: usalo come src di un <audio>)
const first = home.trending.tracks[0];
if (first) {
  const audio = new Audio(solco.streams.audius(first.id));
  await audio.play();
}
```

### Nel browser

Il browser gestisce i cookie di sessione e l'header `Origin`. Usa l'SDK da una
pagina servita dalla stessa origine di Solco (le mutazioni cross-origin restano
bloccate da CORS, come previsto):

```ts
const solco = new SolcoClient({ baseUrl: window.location.origin });
await solco.plays.record('audius:ABC123'); // conta l'ascolto (serve login)
```

### Lato server (Node)

Fuori dal browser l'SDK tiene da sé i cookie di sessione in un `CookieJar` e,
sulle **mutazioni** (POST/PUT/PATCH/DELETE), invia `Origin` = `baseUrl`, così
passa il controllo CSRF same-origin del backend (che confronta `Origin` con
`NEXT_PUBLIC_APP_URL`). Perché funzioni, il `baseUrl` deve coincidere con
l'origine pubblica del deploy.

```ts
import { SolcoClient, SolcoApiError } from '@solco/sdk';

const solco = new SolcoClient({ baseUrl: 'https://solcomusic.vercel.app' });

await solco.auth.signInEmail({ email: 'tu@esempio.it', password: '•••••••••' });
const session = await solco.auth.getSession(); // ora autenticato: il cookie è nel barattolo
const play = await solco.plays.record('audius:ABC123');
console.log(`${play.used}/${play.limit} ascolti del mese`);
```

## Download offline ("scarica il permesso")

Scarica solo ciò che le licenze permettono: brani Audius che l'artista ha marcato
scaricabili (Open Music License) ed episodi di podcast. YouTube, radio e Jamendo
non si scaricano. Serve una sessione (same-origin).

```ts
const dl = await solco.offline.downloadAudiusTrack('ABC123');
// dl.bytes: Uint8Array  — i byte audio
// dl.meta:  titolo, artista, durata, mimeType e ATTRIBUZIONE (licenza + crediti)
// dl.contentType
await fs.writeFile(`${dl.meta.title}.mp3`, dl.bytes);
```

## Gestione degli errori

Ogni stato non-2xx diventa un `SolcoApiError` con `status`, `code` (campo `error`
del corpo), `message`, `retryAfterSeconds` e alcune scorciatoie:

```ts
import { SolcoApiError } from '@solco/sdk';

try {
  await solco.plays.record('audius:ABC123');
} catch (err) {
  if (err instanceof SolcoApiError) {
    if (err.isUnauthorized) /* 401: fai il login */;
    if (err.isForbiddenOrigin) /* 403: origine non consentita */;
    if (err.isRateLimited) /* 429 */ console.log('riprova fra', err.retryAfterSeconds, 's');
  }
}
```

## Cosa copre

| Area | Metodi |
|---|---|
| `auth` | `signInEmail`, `signUpEmail`, `getSession`, `signOut` |
| `music` | `home`, `trending`, `search`, `searchAll`, `mood`, `youtubeCharts`, `sources` |
| `radio` | `list` |
| `podcasts` | `list`, `get` |
| `status` | `public`, `sources` |
| `plays` | `record` |
| `offline` | `downloadAudiusTrack`, `downloadPodcastEpisode` |
| `streams` | `audius`, `jamendo`, `radio`, `podcastEpisode`, `albumTrack`, `track`, `youtubeWatch`, `youtubeEmbed` |

Per endpoint non ancora coperti da un metodo c'è la via di fuga tipizzata:

```ts
const data = await solco.request<MioTipo>('/api/music/genres/pop');
```

### Roadmap (non ancora coperti)

Generi (`/api/music/genres`), libreria e playlist/collezioni, Premium/abbonamenti,
ricompense, community, import da Spotify/track-list. Si raggiungono già con
`solco.request(...)`; avranno metodi dedicati e tipi nelle prossime versioni.

## Note

- **Convalida a runtime:** l'SDK non rivalida le risposte con zod (resta senza
  dipendenze). I tipi riflettono i contratti del backend; chi vuole può passare
  le risposte a uno schema proprio.
- **Licenza:** da definire da parte del proprietario del progetto (`UNLICENSED`).
- **Stato:** v0.1 — scritto e type-checkato in questa sessione, con unit test
  senza rete. Provalo contro un deploy reale prima di affidarti alle mutazioni.

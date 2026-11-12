# Solco offline

Solco si apre anche senza connessione grazie a un Service Worker: un piccolo script
(`public/sw.js`) che il browser installa alla prima visita e che si mette tra l'app e la rete.
Funziona nel browser, nell'app Android (TWA) e su iPhone, sia in Safari sia nell'app aggiunta
alla schermata Home.

## Come funziona

- **Registrazione**: `src/components/custom/service-worker-registration.tsx`, montato in
  `global-mounts.tsx`, registra `/sw.js` con scope `/` **solo in produzione**, solo se il
  browser supporta i Service Worker e solo dopo l'evento `load` (l'installazione scarica decine
  di file e non deve togliere banda alla prima visita). Non lancia mai errori: senza supporto
  l'app funziona come prima, solo senza offline.
- **Pagine** (navigazioni): prima la rete. Se la rete risponde, la pagina arriva normalmente.
  Se manca la connessione il Service Worker mostra subito, in quest'ordine:
  1. la copia salvata della stessa pagina (esiste solo per `/` e `/library`);
  2. la Libreria salvata (`/library`);
  3. la pagina `/offline` («Sei offline», con «Riprova» e il link alla Libreria);
  4. una pagina di riserva minima incorporata in `sw.js`, se anche la cache è vuota.

  Rete lenta ma presente (avvio a freddo, 3G): dopo 4 secondi si usa solo la copia salvata della
  stessa pagina (`/`, `/library`), oppure l'elenco sopra se il dispositivo risulta offline;
  le altre pagine aspettano la rete fino a 10 secondi, poi l'elenco sopra.
- **File statici**: i file con hash di Next (`/_next/static/**`), i font (`/fonts/**`), i loghi
  (`/brand/**`) e le icone si servono prima dalla cache, poi dalla rete. La cache tiene al
  massimo circa 200 file: oltre, si cancellano quelli usati meno di recente (un file servito
  dalla cache torna in fondo alla coda).
- **Manifest** (`/manifest.webmanifest`): prima la rete, la copia salvata solo senza
  connessione.

## Cosa viene salvato

| Cache             | Contenuto                                                                 |
| ----------------- | ------------------------------------------------------------------------- |
| `solco-shell-v1`  | `/offline`, `/library`, `/`, il manifest, le icone principali e i CSS/JS citati dall'HTML salvato di queste tre pagine |
| `solco-static-v1` | CSS, JavaScript, font, loghi e icone usati durante la navigazione (max ~200 voci) |

All'installazione si pre-caricano `/offline` (obbligatoria: se non si scarica, il browser
riprova alla visita successiva), `/library`, il manifest, le icone e i CSS/JS citati
dall'HTML di queste due pagine, così si vedono correttamente anche alla prima apertura offline.
Questi file stanno nella cache del guscio, che non viene sfoltita: `/offline` resta una copia
coerente con il suo CSS anche dopo molti deploy.

L'HTML si salva **solo** per `/` e `/library`: sono gusci che caricano i dati lato client.
Ogni volta che si salva, i CSS/JS che cita si copiano nella cache del guscio (dalla cache
statica, o dalla rete se mancano) e quelli che nessuna pagina salvata cita più si tolgono: la
copia salvata resta sempre apribile e interattiva offline.
Nessun'altra pagina viene salvata, per non riempire lo spazio del telefono e non conservare HTML
personale.

**Mai intercettati né salvati**: `/api/**`, `/health`, `/sw.js`, accesso e account (`/login`,
`/signup`, `/profile`, `/delete-account`), pagamenti (`/checkout`, `/piani/grazie`,
`/piani/paypal`), `/apple-music`, `/invito`, `/admin`, `/dashboard`, `/.well-known`, le
richieste con intestazione `Range` (audio e video), le richieste verso altri domini e tutto ciò
che non è `GET`. Non si salvano nemmeno redirect, errori e la pagina di verifica anti-bot.

I file audio che l'utente aggiunge dal proprio dispositivo restano sul dispositivo e non passano
dal Service Worker: lui non li carica, non li copia e non li invia a nessun server.

Offline la Libreria resta utilizzabile: «La tua musica» funziona del tutto (IndexedDB), mentre al
posto di «Accedi» e «Registrati» (pagine che il Service Worker non salva) compare «Playlist, radio
e podcast tornano quando sei di nuovo online.».

## Aggiornamenti

`/sw.js` si scarica sempre senza cache HTTP (`vercel.json`: `Cache-Control: no-cache, no-store,
must-revalidate` e `Service-Worker-Allowed: /`). Quando il browser trova una versione nuova, la
installa e la lascia **in attesa**: non usa `skipWaiting` all'installazione. La pagina le manda
il messaggio `SKIP_WAITING` solo quando va in secondo piano o alla navigazione successiva, e si
ricarica al massimo una volta, mai con musica in riproduzione o in pausa nei controlli di sistema
(schermata di blocco, notifica Android). L'ascolto non viene mai interrotto.

## Come cambiare la versione della cache

Quando cambia cosa si salva o come (nuove icone, nuove regole, una pagina offline diversa):

1. in `public/sw.js` cambiare `const VERSION = 'v1';` in `'v2'` (poi `'v3'`, …);
2. pubblicare. All'attivazione la nuova versione cancella le cache `solco-shell-*` e
   `solco-static-*` delle versioni precedenti (e solo quelle: le altre cache del sito non si
   toccano).

I file `/_next/static/**` hanno già l'hash nel nome: un normale deploy dell'app **non** richiede
di cambiare versione.

## CSP

Quando si attiva la Content-Security-Policy rigorosa (proxy con nonce e `'strict-dynamic'`),
deve includere `worker-src 'self'`: senza, il browser blocca la registrazione di `/sw.js` e
l'app perde l'offline (continua però a funzionare online). Il CSP inviato con la risposta di
`/sw.js` vale anche dentro il Service Worker: deve consentire `connect-src 'self'` (già presente
nel CSP attuale), perché il Service Worker scarica pagine e file dello stesso sito.

## Provare in locale

Il Service Worker si registra solo in produzione: `SKIP_ENV_VALIDATION=1 npm run build`, poi
`SKIP_ENV_VALIDATION=1 npm start`; quindi in Chrome DevTools → Application → Service Workers spuntare «Offline» e ricaricare.
Tornando a `npm run dev` sulla stessa origine, l'app toglie da sola il `/sw.js` rimasto e le
sue cache `solco-shell-*`/`solco-static-*` al primo caricamento; se una pagina sembra ancora
vecchia, ricaricarla una volta (o DevTools → Application → Service Workers → Unregister).
I test unitari sono `tests/unit/offline-shell-*.test.ts(x)`.

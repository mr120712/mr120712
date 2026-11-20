# Worker yt-dlp per il comando `/video` di Solco

Microservizio minimale che Solco chiama per la funzione **sperimentale** `/video` del bot Telegram.
yt-dlp non può girare dentro Solco (Vercel serverless): questo worker lo esegue altrove.

Due modalità, via `WORKER_MODE`:
- **`extract`** (default) — restituisce l'**URL diretto** del media (nessun file sul worker). Veloce; per
  YouTube il link può essere legato all'IP e a breve scadenza.
- **`serve`** — **scarica** il media e lo **serve** da questo worker a un URL temporaneo `/file/<id>`, con
  pulizia automatica. Robusto per YouTube e permette a Telegram di prelevare il file (così il bot può
  inviarlo IN chat, non solo come link). Richiede disco e banda sul worker.

> ⚠️ Usalo per contenuti **tuoi o liberi**. Non elude DRM/paywall. Tienilo **privato**: imposta
> `WORKER_API_KEY` e non diffondere l'URL del servizio.

## Contratto (quello che Solco si aspetta)

```
POST <YTDLP_SERVICE_URL>/download
Authorization: Bearer <YTDLP_SERVICE_KEY>      # se WORKER_API_KEY è impostata
Content-Type: application/json

Body:      { "url": "https://…" }   oppure   { "query": "parole di ricerca" }
Risposta:  { "url": "<link diretto al media>", "title": "...", "ext": "mp4", "durationSeconds": 123 }
```

C'è anche `GET /health` → `{ "ok": true }`.

## File

- `app.py` — l'endpoint (FastAPI + yt-dlp), modalità `extract` e `serve`.
- `requirements.txt` — fastapi, uvicorn, yt-dlp.
- `Dockerfile` — Python 3.12 + ffmpeg.

## Variabili d'ambiente (worker)

| Variabile | Default | A cosa serve |
|---|---|---|
| `WORKER_API_KEY` | — | Bearer richiesto su `/download` (tienilo impostato). |
| `WORKER_MODE` | `extract` | `extract` (URL diretto) oppure `serve` (scarica e ospita). |
| `PUBLIC_BASE_URL` | (dall'header) | Solo `serve`: l'URL pubblico del worker per costruire i link `/file/<id>`. |
| `FILE_TTL_SECONDS` | `900` | Solo `serve`: dopo quanti secondi i file scaricati vengono cancellati. |
| `MAX_FILESIZE_MB` | `200` | Solo `serve`: tetto alla dimensione scaricata. |

## Avvio in locale

```bash
cd workers/ytdlp-worker
pip install -r requirements.txt
WORKER_API_KEY=unsegretolungo uvicorn app:app --port 8080
# prova:
curl -s -X POST localhost:8080/download \
  -H 'authorization: Bearer unsegretolungo' -H 'content-type: application/json' \
  -d '{"query":"lofi hip hop"}' | jq
```

## Deploy (scegline una)

Tutte e tre leggono il `Dockerfile` e passano `$PORT`.

- **Fly.io** (consigliata — `fly.toml` già incluso, con `WORKER_MODE=serve`). Dentro `workers/ytdlp-worker`:
  ```bash
  fly apps create solco-ytdlp-worker                        # nome preso? scegline un altro e cambia `app` in fly.toml
  fly secrets set WORKER_API_KEY="$(openssl rand -hex 32)"  # lo STESSO valore va in YTDLP_SERVICE_KEY su Vercel
  fly deploy
  ```
  URL risultante: `https://solco-ytdlp-worker.fly.dev` → mettilo in `YTDLP_SERVICE_URL` su Solco. La macchina va a zero quando è inattiva (costo ~0) e riparte da sola alla prima richiesta.
- **Render**: New → Web Service → "Docker" dal repo (root `workers/ytdlp-worker`) → aggiungi la env `WORKER_API_KEY`. URL `https://<app>.onrender.com`.
- **Railway**: New → Deploy from repo (root `workers/ytdlp-worker`) → Variables: `WORKER_API_KEY`. Espone un dominio pubblico.

## Collega a Solco (2 variabili su Vercel + redeploy)

La funzione è **accesa di default**: basta configurare il worker e avere la tua chat tra gli owner.

1. `YTDLP_SERVICE_URL` = l'URL **HTTPS pubblico** del worker (es. `https://tuo-worker.fly.dev`).
2. `YTDLP_SERVICE_KEY` = lo stesso valore di `WORKER_API_KEY` (se l'hai impostato).
3. Assicurati che la **tua** chat Telegram sia in `SKYNET_TELEGRAM_CHAT_IDS` (owner-only).

Opzionali:

- `BOT_VIDEO_AI_MODEL` = l'**agent FreeLLMAPI** che interpreta le richieste in linguaggio naturale
  (un id dal catalogo in **Admin → Monitoraggio**, es. `llama-3.3-70b-versatile`). Vuoto = scelta
  automatica della riserva (`FREELLMAPI_MODEL` o `auto`, sul miglior provider disponibile).
- `BOT_VIDEO_EXPERIMENTAL` = `0` per **spegnere** la funzione (interruttore di sicurezza). Qualsiasi
  altro valore, o nessun valore, la lascia accesa.

Poi redeploy di Solco e, in **chat privata** col bot: `/video <url o descrizione>`.

## Note e limiti

- **Quale modalità**: usa `serve` se ti serve **YouTube affidabile** o l'invio del file dentro Telegram;
  usa `extract` (più leggero, senza storage) per X/Twitter, TikTok, file diretti, dove l'URL diretto va bene.
- **Invio in Telegram**: in modalità `serve` il worker torna anche `filesize`; Solco, se è un video sotto
  ~20 MB, prova a inviarlo DENTRO la chat (sendVideo da URL), altrimenti manda il link. I bot Telegram
  inviano da URL fino a ~20 MB.
- **Pulizia**: i file scaricati si cancellano da soli dopo `FILE_TTL_SECONDS` (default 15 min).
- **Tieni yt-dlp aggiornato**: ricostruisci l'immagine ogni tanto (i siti cambiano).

## YouTube: «Sign in to confirm you're not a bot»

Da un IP da datacenter (Render, Fly, …) YouTube risponde con questo messaggio a **ogni** client di
yt-dlp: è l'indirizzo a essere fermato, non la richiesta. Lo si supera in tre modi, dal meno al più
impegnativo: uscire da **Cloudflare WARP** (gratis, una variabile), usare un **proxy** residenziale, dare
i **cookie** di un account. Il worker ha un **anti-bot** in quattro parti:

1. **Rileva** il controllo e lo distingue dagli altri errori. `/download` risponde `502` con un codice in
   `detail`: `youtube_bot_check`, `media_unavailable`, `rate_limited`, `login_required`, `unavailable`,
   `proxy_unreachable`, `proxy_error` (oppure il generico `download failed` / `extraction failed`). Il
   bot di Solco traduce il codice nel rimedio. A `youtube_bot_check` si accodano le leve **già attive**
   (`+cookies`, `+proxy`, `+warp` se è fermata anche l'uscita WARP, `+warp_down` se WARP è acceso ma non
   disponibile): così il bot non consiglia di impostare ciò che c'è già, ma dice cosa non va.
2. **Cambia uscita**: con `YTDLP_WARP=1` yt-dlp esce da Cloudflare WARP e l'IP del worker resta di
   riserva (vedi [Uscire da Cloudflare WARP](#uscire-da-cloudflare-warp)).
3. **Cambia client**: quando un client YouTube non dà il file (403 sul media, «The page needs to be
   reloaded», nessun file unico audio+video → `media_unavailable`) prova i successivi
   (`YTDLP_FALLBACK_CLIENTS`, uno alla volta, entro `YTDLP_ANTIBOT_BUDGET_SECONDS`) e **ricorda** quello
   che passa. Contro il controllo anti-bot cambiare client non basta: lo ricevono tutti.
4. **Sonda**: `GET /antibot` (con la chiave, come `/download`) estrae un video pubblico senza scaricarlo e
   dice se questo worker passa il controllo, da quale uscita, con che client e cosa fare se no:

   ```bash
   curl -H "Authorization: Bearer $WORKER_API_KEY" https://<worker>/antibot
   # {"youtube":"ok","client":"default","exit":"warp","tried":["warp/default"],"warp":"ready",...}
   # {"youtube":"youtube_bot_check","client":null,"exit":null,"tried":["default","tv_samsung",...],"hint":"..."}
   ```

`GET /health` (pubblico, nessun segreto) mostra lo stato in `antibot`: i client di fallback, quello
preferito, se c'è un proxy (`proxy`, `proxy_info`), lo stato dell'uscita WARP (`warp`) e l'esito
dell'**ultima** richiesta (`last`: `status`, `client`, `exit`).

### Che cosa passa e che cosa no (misurato)

Misura del 20 novembre 2026 con yt-dlp 2026.10.26, da runner GitHub (IP Microsoft Azure, cioè da
datacenter come Render). Si rifà con il workflow «Worker yt-dlp: misura anti-bot».

| Uscita | Che cosa è stato provato | Esito |
|---|---|---|
| IP del runner | 11 client YouTube, anche senza scaricare la pagina del video | `LOGIN_REQUIRED` su tutti |
| IP del runner + PO Token | provider `bgutil` 2.0.2, token chiesto sempre (`fetch_pot=always`) | token generato, `LOGIN_REQUIRED` lo stesso |
| WARP, modalità **proxy** | client ufficiale e `usque l4-socks` | estrazione e download riusciti (default, `tv_samsung`, `mweb`, `android_vr`, `web_embedded`) |
| WARP, modalità **tunnel** | `usque socks`, su QUIC e su HTTP/2 | `LOGIN_REQUIRED` su tutti |

Due conseguenze nel worker: i PO Token non sono installati (non servono contro un blocco sull'IP), e
l'uscita WARP usa solo la modalità proxy. Il client **ufficiale** di Cloudflare non è utilizzabile su
Render: in un container senza privilegi resta in «Connecting». Per questo l'immagine usa `usque`, che
gira tutto in spazio utente (19 MB di memoria, pronto in 3 secondi).

| Variabile | Effetto |
|---|---|
| `YTDLP_COOKIES` | Contenuto di un `cookies.txt` (formato Netscape) dei TUOI cookie YouTube. Rimedio forte, il più affidabile. **È un SEGRETO** → impostalo come secret, mai in chiaro nel repo o in `fly.toml`. |
| `YTDLP_COOKIES_FILE` | In alternativa, il percorso a un `cookies.txt` già montato nel container. Su Render un Secret File `cookies.txt` (`/etc/secrets/cookies.txt`) è rilevato da solo. |
| `YTDLP_PROXY` | Proxy in uscita per yt-dlp, utile se l'IP del worker è bloccato: vedi [Impostare un proxy](#impostare-un-proxy). **SEGRETO** se contiene credenziali; non finisce mai nei log né in `/health`. |
| `YTDLP_PROXY_CONNECT_TIMEOUT` | Secondi concessi al proxy per accettare la connessione prima di ogni richiesta (default `5`). Oltre, l'esito è `proxy_unreachable` senza avviare yt-dlp. |
| `YTDLP_WARP` | `1` accende l'uscita gratuita da Cloudflare WARP: vedi [Uscire da Cloudflare WARP](#uscire-da-cloudflare-warp). Spenta di default; ignorata se c'è `YTDLP_PROXY`. |
| `YTDLP_PLAYER_CLIENT` | Forza il client del PRIMO tentativo (CSV), es. `android` o `ios,web`. Vuoto = default di yt-dlp. |
| `YTDLP_FALLBACK_CLIENTS` | Client provati quando il precedente non dà il file (default `tv_samsung,mweb,android_vr,web_embedded`, quelli che nella misura danno un file unico audio+video). Vuoto = nessun fallback. |
| `YTDLP_ANTIBOT_BUDGET_SECONDS` | Oltre questo tempo non si iniziano altri tentativi (default `25`; il bot di Solco aspetta 40 s). |
| `YTDLP_PROBE_URL` | Video usato da `GET /antibot` (default: un video pubblico e stabile). |

**Runtime JavaScript.** `requirements.txt` installa `yt-dlp[default]` (con `yt-dlp-ejs`) e `deno`: YouTube
protegge i formati con "challenge" JavaScript e yt-dlp, senza un runtime che le risolva, ripiega
sull'estrazione senza JavaScript, che dichiara deprecata e con formati mancanti.

### Uscire da Cloudflare WARP

La leva gratuita, e l'unica che non chiede né un account né un abbonamento: yt-dlp esce dalla rete di
Cloudflare invece che dall'IP del worker.

- **Come si accende.** Render → il servizio → **Environment** → variabile `YTDLP_WARP` = `1` → salva (il
  servizio riparte da solo). Su Fly: `fly secrets set YTDLP_WARP=1`.
- **Che cosa fa.** All'avvio il worker registra un dispositivo WARP gratuito e apre un SOCKS5 **solo
  locale** (`127.0.0.1`). Da quel momento yt-dlp esce da lì: richiesta e download insieme, perché YouTube
  lega il link del media all'IP che lo ha chiesto (per questo serve la modalità `serve`: in `extract`
  il link restituito varrebbe solo da quell'uscita). L'IP del worker resta di riserva, per quando WARP
  non è disponibile o viene fermato a sua volta. Con `YTDLP_PROXY` impostato WARP non viene usato: il
  proxy è la scelta esplicita dell'owner.
- **Che cosa accetti accendendola.** I [termini di Cloudflare per WARP](https://www.cloudflare.com/application/terms/):
  il worker li accetta al posto tuo quando registra il dispositivo, ed è per questo che la leva è spenta
  finché non la accendi tu. Il client è [`usque`](https://github.com/Diniboy1123/usque), open-source e
  **non ufficiale**: Cloudflare può smettere di accettarlo, e allora il worker torna all'uscita diretta.
- **Nessuna garanzia.** YouTube può fermare anche gli indirizzi di WARP: il codice diventa
  `youtube_bot_check+warp`, di solito passa riprovando, e restano il proxy e i cookie.
- **Controlla** `GET /health` dopo il riavvio: `antibot.warp` è `{"enabled": true, "state": "ready"}`.
  `state: "failed"` ha un `error` che dice perché (registrazione rifiutata o limitata, Cloudflare non
  raggiungibile, tunnel che non risponde: serve traffico **UDP** in uscita). Il worker riprova da solo
  dopo 5, 30 e 120 secondi, poi a ogni richiesta.
- **Isolamento.** Il client gira senza le variabili d'ambiente del worker e, quando il container lo
  permette, come utente `nobody`: non vede né `WORKER_API_KEY` né i cookie. È compilato nell'immagine da
  un commit fisso del suo sorgente (vedi `Dockerfile`). Ogni avvio del container registra un nuovo
  dispositivo WARP: su un piano che spegne il servizio quando è fermo succede a ogni risveglio.

### Impostare i cookie (il rimedio quando l'esito è `youtube_bot_check`)

1. **Esporta `cookies.txt`** da un browser su computer, con un account YouTube **secondario**:
   apri una finestra in incognito, accedi a YouTube, poi nella stessa scheda vai su
   `https://www.youtube.com/robots.txt` ed esporta i cookie di quella scheda con un'estensione tipo
   «Get cookies.txt LOCALLY» (formato Netscape). Chiudi la finestra in incognito senza fare logout:
   così la sessione non viene più usata dal browser e i cookie non vengono ruotati.
2. **Dalli al worker** in uno di questi modi (dal più comodo):
   - **Render → Environment → Secret Files**: aggiungi un file chiamato esattamente `cookies.txt` e
     incolla il contenuto. Viene montato in `/etc/secrets/cookies.txt` e il worker lo usa da solo.
   - Variabile `YTDLP_COOKIES` con il contenuto del file (secret), oppure `YTDLP_COOKIES_FILE` con il
     percorso di un file già montato.
   - Fly: `fly secrets set YTDLP_COOKIES="$(cat cookies.txt)" -a solco-ytdlp-worker`
     (PowerShell: `"$(Get-Content cookies.txt -Raw)"`).
3. **Controlla** `GET /health` dopo il riavvio: `cookies_info` dice da dove sono stati presi
   (`source`), quanti sono (`count`) e se ce ne sono di YouTube (`youtube`), senza mai mostrare nomi o
   valori. Con `count: 0` c'è un `error` che spiega perché.

Il worker lavora sempre su una copia scrivibile e **ripara** ciò che un campo web fa a questo file: fine
riga Windows, TAB diventati spazi, righe fuse in una sola, intestazione mancante. Le righe illeggibili
vengono scartate (contate in `skipped`), così nessun valore di cookie finisce nei log.

> I cookie danno accesso al tuo account YouTube: trattali come una password e usa un account secondario.
> Scadono o vengono invalidati: se torna `youtube_bot_check` o `login_required`, riesportali.

### Impostare un proxy

L'alternativa a pagamento a WARP: far uscire yt-dlp da un IP che YouTube non blocca, scelto da te.

- **Che proxy serve.** Un proxy **residenziale** o **mobile** di un fornitore a pagamento. I proxy
  *datacenter* (e quasi tutti quelli gratuiti) sono bloccati come l'IP del worker: l'esito resta
  `youtube_bot_check`, e il codice diventa `youtube_bot_check+proxy` per dirlo.
- **Quanto traffico.** In modalità `serve` passa dal proxy **l'intero file**, non solo la richiesta
  iniziale (YouTube lega il link del media all'IP che lo ha chiesto). I proxy residenziali si pagano a
  GB: `MAX_FILESIZE_MB` (default `200`) è anche il tetto al consumo per singolo video.
- **Dove si imposta.** Render → il servizio → **Environment** → variabile `YTDLP_PROXY` → salva (il
  servizio riparte da solo). Su Fly: `fly secrets set YTDLP_PROXY="…"`. Mai nel repo.
- **Formati accettati.** Incolla la stringa così come la dà il fornitore:

  | Formato | Esempio |
  |---|---|
  | URL | `http://utente:password@host:porta` (anche `https://`, `socks5://`, `socks5h://`, `socks4://`) |
  | host prima | `host:porta:utente:password` |
  | credenziali prima | `utente:password:host:porta` |
  | senza schema | `utente:password@host:porta`, oppure `host:porta` se il proxy autorizza per IP |

  Senza schema si assume `http`; per un SOCKS5 in forma «a due punti» anteponi lo schema
  (`socks5://host:porta:utente:password`). Una password con `@`, `:`, `/` o `#` va bene così com'è: il
  worker la codifica da solo.
- **Un proxy solo.** Se incolli un elenco (una riga per proxy, come lo scaricano i fornitori) viene
  usato il primo leggibile, sempre lo stesso; `proxy_info.ignored` conta gli altri.
- **Controlla** `GET /health` dopo il riavvio: `antibot.proxy` è `true` e `proxy_info.scheme` dice lo
  schema letto. Se il valore non è interpretabile il proxy **non viene usato** e `proxy_info.error`
  spiega perché (host e credenziali non compaiono mai).

Alla prima richiesta, `antibot.last.status` dice com'è andata:

| Esito | Significato | Rimedio |
|---|---|---|
| `ok` | YouTube risponde attraverso il proxy. | — |
| `proxy_unreachable` | Host o porta non accettano connessioni (controllo fatto prima di avviare yt-dlp). | Controlla host e porta; il servizio proxy è attivo? |
| `proxy_error` | Il proxy ha risposto ma ha rifiutato (es. `407`). | Utente/password, credito residuo, YouTube consentito dal piano, IP del worker autorizzato. |
| `youtube_bot_check` | Il proxy funziona, ma YouTube blocca anche il suo IP. | Proxy residenziale/mobile, o i cookie. |

Cookie e proxy si possono usare insieme, e così cookie e WARP.

## Diagnostica

Il worker logga su stdout (`fly logs -a solco-ytdlp-worker`): all'avvio stampa la config risolta
(`mode`, `auth`, `cookies`, `proxy`, `warp`, `player_client`, `fallback`), poi ogni richiesta
(`richiesta download: …`), l'esito (`download ok …`) e, su errore, il **motivo preciso** di yt-dlp per
ogni tentativo (`yt-dlp fallito (tentativo=warp/tv_samsung, esito=media_unavailable): …`; senza
prefisso è l'uscita diretta o il proxy). È l'unica riga per errore: yt-dlp non scrive la sua su stderr, e
questa passa da un filtro che toglie l'URL e le credenziali del proxy. Le righe `WARP: …` dicono quando
l'uscita è pronta o perché non lo è.
`GET /health` riporta anche `{"auth": …, "cookies": true|false, "player_client": …, "antibot": {…}}` per
confermare al volo che l'env è attivo.

Test del worker (yt-dlp e client WARP finti, nessuna rete), dalla cartella del worker:

```bash
pip install -r requirements.txt httpx && python -m unittest -v test_antibot
```

Il workflow «Worker yt-dlp: collaudo» li esegue dentro l'immagine a ogni modifica; avviato a mano
fa anche la prova dal vivo: il container, con WARP acceso, scarica un video da YouTube partendo da un
runner il cui IP da solo riceve il controllo anti-bot.

## Sicurezza (cifratura end-to-end)

| Livello | Come |
|---|---|
| **Trasporto (in transito)** | TLS ovunque: `force_https` in `fly.toml` cifra sia Solco→worker (`/download`) sia Telegram/utente→worker (`/file`). Niente HTTP in chiaro. |
| **Auth — FAIL-CLOSED** | Senza `WORKER_API_KEY` il worker risponde **503 a tutto** (non parte mai «aperto» per sbaglio). `/download` esige `Authorization: Bearer <WORKER_API_KEY>`, confronto a tempo costante. Per i soli test locali: `WORKER_ALLOW_OPEN=1`. |
| **Link ai file — FIRMATI + a scadenza** | In modalità `serve` l'URL è `/file/<id>?exp=<ts>&sig=<hmac>`: HMAC-SHA256 con `WORKER_API_KEY`, legato al nome file e a una scadenza = `FILE_TTL_SECONDS`. Non falsificabile senza la chiave e non riusabile dopo la scadenza; il file viene comunque cancellato alla stessa scadenza. Telegram può prelevarlo senza conoscere la chiave (basta il link firmato). |
| **Segreti (a riposo)** | `WORKER_API_KEY`, `YTDLP_COOKIES` e `YTDLP_PROXY` vanno impostati come **secret di Fly** (`fly secrets set …`) — cifrati a riposo, mai nel repo né in `fly.toml`. I log non stampano mai chiavi, cookie o credenziali del proxy. |
| **Uscita WARP** | Il SOCKS del client WARP ascolta solo su `127.0.0.1`. Il client gira con l'ambiente vuoto e, potendo, come `nobody`: non riceve la chiave del worker né i cookie. La sua registrazione resta in una cartella `0700` dentro il container e sparisce con lui. |

In breve: imposta `WORKER_API_KEY` come secret (lo STESSO valore di `YTDLP_SERVICE_KEY` su Vercel) e il canale è cifrato end-to-end, autenticato e con link usa-e-getta. `GET /health` → `"auth":"required"` conferma che è chiuso correttamente (`"unconfigured"` = manca la chiave = tutto 503).

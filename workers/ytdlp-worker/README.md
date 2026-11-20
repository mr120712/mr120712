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

Da un IP datacenter (Fly, Render, …) YouTube spesso blocca i download con questo messaggio. Il worker ha
un **anti-bot** in tre parti:

1. **Rileva** il controllo e lo distingue dagli altri errori. `/download` risponde `502` con un codice in
   `detail`: `youtube_bot_check`, `rate_limited`, `login_required`, `unavailable` (oppure il generico
   `download failed` / `extraction failed`). Il bot di Solco traduce il codice nel rimedio da applicare.
2. **Riprova da solo** con altri client YouTube (`YTDLP_FALLBACK_CLIENTS`, uno alla volta, entro
   `YTDLP_ANTIBOT_BUDGET_SECONDS`) e **ricorda** quello che passa, usandolo per primo alle richieste dopo.
   È un tentativo a costo zero, non una garanzia: se l'IP è bloccato servono i cookie o un proxy.
3. **Sonda**: `GET /antibot` (con la chiave, come `/download`) estrae un video pubblico senza scaricarlo e
   dice se questo worker passa il controllo, con che client e cosa fare se no:

   ```bash
   curl -H "Authorization: Bearer $WORKER_API_KEY" https://<worker>/antibot
   # {"youtube":"ok","client":"default","tried":["default"],"cookies":false,"proxy":false,...}
   # {"youtube":"youtube_bot_check","client":null,"tried":["default","tv",...],"hint":"...YTDLP_COOKIES..."}
   ```

`GET /health` (pubblico, nessun segreto) mostra lo stato in `antibot`: i client di fallback, quello
preferito e l'esito dell'**ultima** richiesta (`last.status`).

| Variabile | Effetto |
|---|---|
| `YTDLP_COOKIES` | Contenuto di un `cookies.txt` (formato Netscape) dei TUOI cookie YouTube. Rimedio forte, il più affidabile. **È un SEGRETO** → impostalo come secret, mai in chiaro nel repo o in `fly.toml`. |
| `YTDLP_COOKIES_FILE` | In alternativa, il percorso a un `cookies.txt` già montato nel container. |
| `YTDLP_PROXY` | Proxy in uscita per yt-dlp (es. `http://utente:password@host:porta`), utile se l'IP del worker è bloccato. **SEGRETO** se contiene credenziali; non finisce mai nei log. |
| `YTDLP_PLAYER_CLIENT` | Forza il client del PRIMO tentativo (CSV), es. `android` o `ios,web`. Vuoto = default di yt-dlp. |
| `YTDLP_FALLBACK_CLIENTS` | Client provati dopo un controllo anti-bot (default `tv,android_vr,web_safari,mweb`). Vuoto = nessun fallback. |
| `YTDLP_ANTIBOT_BUDGET_SECONDS` | Oltre questo tempo non si iniziano altri tentativi (default `25`; il bot di Solco aspetta 40 s). |
| `YTDLP_PROBE_URL` | Video usato da `GET /antibot` (default: un video pubblico e stabile). |

**Runtime JavaScript.** `requirements.txt` installa `yt-dlp[default]` (con `yt-dlp-ejs`) e `deno`: YouTube
protegge i formati con "challenge" JavaScript e yt-dlp, senza un runtime che le risolva, ripiega
sull'estrazione senza JavaScript, che dichiara deprecata e con formati mancanti.

Esporta i cookie con un'estensione «Get cookies.txt» dal browser dove sei loggato su YouTube, poi:

```powershell
# PowerShell
fly secrets set YTDLP_COOKIES="$(Get-Content cookies.txt -Raw)" -a solco-ytdlp-worker
```
```bash
# bash
fly secrets set YTDLP_COOKIES="$(cat cookies.txt)" -a solco-ytdlp-worker
```

> I cookie danno accesso al tuo account YouTube: trattali come una password. Usa un account secondario se puoi.

## Diagnostica

Il worker logga su stdout (`fly logs -a solco-ytdlp-worker`): all'avvio stampa la config risolta
(`mode`, `auth`, `cookies`, `proxy`, `player_client`, `fallback`), poi ogni richiesta (`richiesta download: …`),
l'esito (`download ok …`) e, su errore, il **motivo preciso** di yt-dlp per ogni client provato
(`yt-dlp fallito (client=tv, esito=youtube_bot_check): …`).
`GET /health` riporta anche `{"auth": …, "cookies": true|false, "player_client": …, "antibot": {…}}` per
confermare al volo che l'env è attivo.

Test dell'anti-bot (yt-dlp finto, nessuna rete), dalla cartella del worker:

```bash
pip install -r requirements.txt httpx && python -m unittest -v test_antibot
```

## Sicurezza (cifratura end-to-end)

| Livello | Come |
|---|---|
| **Trasporto (in transito)** | TLS ovunque: `force_https` in `fly.toml` cifra sia Solco→worker (`/download`) sia Telegram/utente→worker (`/file`). Niente HTTP in chiaro. |
| **Auth — FAIL-CLOSED** | Senza `WORKER_API_KEY` il worker risponde **503 a tutto** (non parte mai «aperto» per sbaglio). `/download` esige `Authorization: Bearer <WORKER_API_KEY>`, confronto a tempo costante. Per i soli test locali: `WORKER_ALLOW_OPEN=1`. |
| **Link ai file — FIRMATI + a scadenza** | In modalità `serve` l'URL è `/file/<id>?exp=<ts>&sig=<hmac>`: HMAC-SHA256 con `WORKER_API_KEY`, legato al nome file e a una scadenza = `FILE_TTL_SECONDS`. Non falsificabile senza la chiave e non riusabile dopo la scadenza; il file viene comunque cancellato alla stessa scadenza. Telegram può prelevarlo senza conoscere la chiave (basta il link firmato). |
| **Segreti (a riposo)** | `WORKER_API_KEY` e `YTDLP_COOKIES` vanno impostati come **secret di Fly** (`fly secrets set …`) — cifrati a riposo, mai nel repo né in `fly.toml`. I log non stampano mai chiavi né cookie. |

In breve: imposta `WORKER_API_KEY` come secret (lo STESSO valore di `YTDLP_SERVICE_KEY` su Vercel) e il canale è cifrato end-to-end, autenticato e con link usa-e-getta. `GET /health` → `"auth":"required"` conferma che è chiuso correttamente (`"unconfigured"` = manca la chiave = tutto 503).

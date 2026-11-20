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

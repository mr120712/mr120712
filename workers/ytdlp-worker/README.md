# Worker yt-dlp per il comando `/video` di Solco

Microservizio minimale che Solco chiama per la funzione **sperimentale** `/video` del bot Telegram.
yt-dlp non può girare dentro Solco (Vercel serverless): questo worker lo esegue altrove e restituisce
un **URL diretto** al media, che il bot rimanda come link.

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

- `app.py` — l'endpoint (FastAPI + yt-dlp).
- `requirements.txt` — fastapi, uvicorn, yt-dlp.
- `Dockerfile` — Python 3.12 + ffmpeg.

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

- **Fly.io**: `fly launch --no-deploy` (conferma il Dockerfile) → `fly secrets set WORKER_API_KEY=…` → `fly deploy`. L'URL è `https://<app>.fly.dev`.
- **Render**: New → Web Service → "Docker" dal repo (root `workers/ytdlp-worker`) → aggiungi la env `WORKER_API_KEY`. URL `https://<app>.onrender.com`.
- **Railway**: New → Deploy from repo (root `workers/ytdlp-worker`) → Variables: `WORKER_API_KEY`. Espone un dominio pubblico.

## Collega a Solco (3 variabili su Vercel + redeploy)

1. `YTDLP_SERVICE_URL` = l'URL **HTTPS pubblico** del worker (es. `https://tuo-worker.fly.dev`).
2. `YTDLP_SERVICE_KEY` = lo stesso valore di `WORKER_API_KEY` (se l'hai impostato).
3. `BOT_VIDEO_EXPERIMENTAL` = `1`.
4. Assicurati che la **tua** chat Telegram sia in `SKYNET_TELEGRAM_CHAT_IDS` (owner-only).

Poi redeploy di Solco e, in **chat privata** col bot: `/video <url o descrizione>`.

## Limiti onesti

- **Link diretto, non file**: niente storage sul worker. Per **YouTube** l'URL diretto è spesso
  **legato all'IP** e a breve scadenza: aperto da un IP diverso può dare 403. Funziona bene per molti
  altri siti (X/Twitter, TikTok, file diretti…). Per YouTube affidabile serve una variante
  **scarica-e-ospita** (il worker scarica il file e lo serve/caricà da sé): te la preparo se ti serve.
- **Dimensioni**: se poi vorrai inviare il file DENTRO Telegram invece del link, valgono i limiti dei
  bot (~50 MB).
- **Tieni yt-dlp aggiornato**: ricostruisci l'immagine ogni tanto (i siti cambiano).

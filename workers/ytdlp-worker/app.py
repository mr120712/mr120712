# Worker yt-dlp per il comando sperimentale /video del bot Telegram di Solco.
#
# Solco NON può eseguire yt-dlp (Vercel serverless), quindi delega QUI. Questo servizio riceve
# {url} o {query}, usa yt-dlp per ESTRARRE l'URL diretto del media (senza scaricare il file) e lo
# restituisce; il bot lo rimanda come link. Tienilo PRIVATO: imposta WORKER_API_KEY e non diffondere
# l'URL. Uso consentito: contenuti tuoi o liberi — non eludere DRM/paywall (yt-dlp non lo fa).
import hmac
import os

import yt_dlp
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

API_KEY = os.environ.get("WORKER_API_KEY", "").strip()

app = FastAPI(title="Solco yt-dlp worker")


class DownloadRequest(BaseModel):
    url: str | None = None
    query: str | None = None
    format: str | None = "best"


def _check_auth(authorization: str | None) -> None:
    # Nessuna chiave impostata = aperto: in quel caso TIENI il servizio non pubblico.
    if not API_KEY:
        return
    expected = f"Bearer {API_KEY}"
    if not authorization or not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="unauthorized")


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/download")
def download(req: DownloadRequest, authorization: str | None = Header(default=None)) -> dict:
    _check_auth(authorization)

    # Un URL diretto, oppure una ricerca: ytsearch1 prende il primo risultato.
    target = req.url or (f"ytsearch1:{req.query}" if req.query else None)
    if not target:
        raise HTTPException(status_code=400, detail="url or query required")

    # Preferisci un singolo flusso progressivo (audio+video insieme) = un URL riproducibile;
    # ripiega su "best". skip_download: estraiamo solo i metadati, niente file sul worker.
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        "default_search": "ytsearch",
        "format": "best[acodec!=none][vcodec!=none]/best",
        "socket_timeout": 30,
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(target, download=False)
    except Exception:
        # Nessun dettaglio interno al chiamante.
        raise HTTPException(status_code=502, detail="extraction failed") from None

    # ytsearch restituisce una "playlist" di un elemento.
    entries = [entry for entry in (info.get("entries") or []) if entry]
    if entries:
        info = entries[0]

    media_url = info.get("url")
    if not media_url:
        requested = info.get("requested_formats") or []
        if requested:
            media_url = requested[0].get("url")
    if not media_url:
        raise HTTPException(status_code=404, detail="no playable url found")

    duration = info.get("duration")
    return {
        "url": media_url,
        "title": info.get("title"),
        "ext": info.get("ext"),
        "durationSeconds": int(duration) if isinstance(duration, (int, float)) else None,
    }

# Worker yt-dlp per il comando sperimentale /video del bot Telegram di Solco.
#
# Solco NON può eseguire yt-dlp (Vercel serverless), quindi delega QUI. Due modalità (WORKER_MODE):
#   - "extract" (default): ESTRAE l'URL diretto del media e lo restituisce (nessun file sul worker).
#       Veloce, senza storage; per YouTube l'URL può essere legato all'IP e a breve scadenza.
#   - "serve": SCARICA il media e lo SERVE da questo worker a un URL temporaneo (/file/<id>), con
#       pulizia automatica dopo FILE_TTL_SECONDS. Robusto per YouTube (il link è del worker, non del
#       CDN d'origine) e permette a Telegram di prelevare il file. Richiede disco e banda sul worker.
#
# Tienilo PRIVATO: imposta WORKER_API_KEY e non diffondere l'URL. Uso consentito: contenuti tuoi o
# liberi — non elude DRM/paywall (yt-dlp non lo fa).
import asyncio
import hmac
import mimetypes
import os
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import yt_dlp
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel

API_KEY = os.environ.get("WORKER_API_KEY", "").strip()
MODE = os.environ.get("WORKER_MODE", "extract").strip().lower()
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "").strip().rstrip("/")
FILE_TTL_SECONDS = int(os.environ.get("FILE_TTL_SECONDS", "900"))
MAX_FILESIZE_MB = int(os.environ.get("MAX_FILESIZE_MB", "200"))
DOWNLOAD_DIR = Path(os.environ.get("DOWNLOAD_DIR", "/tmp/ytdlp-serve"))

FORMAT = "best[acodec!=none][vcodec!=none]/best"


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


def _sweep() -> None:
    """Cancella i file scaricati più vecchi di FILE_TTL_SECONDS."""
    now = time.time()
    for path in DOWNLOAD_DIR.glob("*"):
        try:
            if path.is_file() and now - path.stat().st_mtime > FILE_TTL_SECONDS:
                path.unlink()
        except OSError:
            pass


async def _cleanup_loop() -> None:
    while True:
        _sweep()
        await asyncio.sleep(120)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    task = None
    if MODE == "serve":
        DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
        task = asyncio.create_task(_cleanup_loop())
    yield
    if task:
        task.cancel()


app = FastAPI(title="Solco yt-dlp worker", lifespan=lifespan)


@app.get("/health")
def health() -> dict:
    return {"ok": True, "mode": MODE}


def _target(req: DownloadRequest) -> str:
    target = req.url or (f"ytsearch1:{req.query}" if req.query else None)
    if not target:
        raise HTTPException(status_code=400, detail="url or query required")
    return target


def _pick_entry(info: dict) -> dict:
    # ytsearch restituisce una "playlist" di un elemento.
    entries = [entry for entry in (info.get("entries") or []) if entry]
    return entries[0] if entries else info


@app.post("/download")
def download(
    req: DownloadRequest,
    request: Request,
    authorization: str | None = Header(default=None),
) -> dict:
    _check_auth(authorization)
    target = _target(req)
    return _serve_download(target, request) if MODE == "serve" else _extract_url(target)


def _extract_url(target: str) -> dict:
    """Modalità extract: nessun download, solo l'URL diretto del media."""
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        "default_search": "ytsearch",
        "format": FORMAT,
        "socket_timeout": 30,
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = _pick_entry(ydl.extract_info(target, download=False))
    except Exception:
        raise HTTPException(status_code=502, detail="extraction failed") from None

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


def _serve_download(target: str, request: Request) -> dict:
    """Modalità serve: scarica il media e restituisce un URL di questo worker (/file/<id>)."""
    _sweep()
    token = uuid.uuid4().hex
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "default_search": "ytsearch",
        "format": FORMAT,
        "outtmpl": str(DOWNLOAD_DIR / f"{token}.%(ext)s"),
        "max_filesize": MAX_FILESIZE_MB * 1024 * 1024,
        "socket_timeout": 30,
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = _pick_entry(ydl.extract_info(target, download=True))
            path = Path(ydl.prepare_filename(info))
    except Exception:
        raise HTTPException(status_code=502, detail="download failed") from None

    if not path.is_file():
        # max_filesize superato o nessun formato scaricabile.
        raise HTTPException(status_code=413, detail="file too large or not downloadable")

    base = PUBLIC_BASE_URL or str(request.base_url).rstrip("/")
    duration = info.get("duration")
    return {
        "url": f"{base}/file/{path.name}",
        "title": info.get("title"),
        "ext": info.get("ext"),
        "durationSeconds": int(duration) if isinstance(duration, (int, float)) else None,
        "filesize": path.stat().st_size,
    }


@app.get("/file/{name}")
def serve_file(name: str) -> FileResponse:
    # Solo un nome di file semplice dentro DOWNLOAD_DIR: niente "/" né "..".
    if "/" in name or "\\" in name or name in ("", ".", ".."):
        raise HTTPException(status_code=400, detail="bad name")
    path = (DOWNLOAD_DIR / name).resolve()
    if DOWNLOAD_DIR.resolve() not in path.parents or not path.is_file():
        raise HTTPException(status_code=404, detail="not found")
    media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return FileResponse(path, media_type=media_type, filename=path.name)

# Worker yt-dlp per il comando sperimentale /video del bot Telegram di Solco.
#
# Solco NON può eseguire yt-dlp (Vercel serverless), quindi delega QUI. Due modalità (WORKER_MODE):
#   - "extract" (default): ESTRAE l'URL diretto del media e lo restituisce (nessun file sul worker).
#       Veloce, senza storage; per YouTube l'URL può essere legato all'IP e a breve scadenza.
#   - "serve": SCARICA il media e lo SERVE da questo worker a /file/<id>, con pulizia automatica dopo
#       FILE_TTL_SECONDS. Robusto per YouTube (il link è del worker) e permette a Telegram di prelevarlo.
#
# Tienilo PRIVATO: imposta WORKER_API_KEY e non diffondere l'URL. Uso consentito: contenuti tuoi o
# liberi — non elude DRM/paywall (yt-dlp non lo fa).
#
# YouTube da IP datacenter (Fly/Render/…) spesso risponde "Sign in to confirm you're not a bot".
# Mitigazioni, via env (vedi README):
#   - YTDLP_COOKIES       = contenuto di un cookies.txt (formato Netscape) → scritto su file e passato a yt-dlp
#   - YTDLP_COOKIES_FILE  = percorso a un cookies.txt già montato nel container (alternativa a YTDLP_COOKIES)
#   - YTDLP_PLAYER_CLIENT = client YouTube da forzare, CSV (es. "android" o "ios,web"); vuoto = default yt-dlp
import asyncio
import hmac
import logging
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

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("ytdlp-worker")

API_KEY = os.environ.get("WORKER_API_KEY", "").strip()
MODE = os.environ.get("WORKER_MODE", "extract").strip().lower()
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "").strip().rstrip("/")
FILE_TTL_SECONDS = int(os.environ.get("FILE_TTL_SECONDS", "900"))
MAX_FILESIZE_MB = int(os.environ.get("MAX_FILESIZE_MB", "200"))
DOWNLOAD_DIR = Path(os.environ.get("DOWNLOAD_DIR", "/tmp/ytdlp-serve"))
PLAYER_CLIENT = os.environ.get("YTDLP_PLAYER_CLIENT", "").strip()
COOKIES_FILE_ENV = os.environ.get("YTDLP_COOKIES_FILE", "").strip()
_COOKIES_INLINE = os.environ.get("YTDLP_COOKIES", "")

# Formato pre-muxato (audio+video insieme): evita il merge ffmpeg e dà un singolo file/URL riproducibile.
FORMAT = "best[acodec!=none][vcodec!=none]/best"

# Risolto una volta allo startup (lifespan): percorso a un cookies.txt usabile, o None.
COOKIEFILE: str | None = None


class DownloadRequest(BaseModel):
    url: str | None = None
    query: str | None = None
    format: str | None = None


def _resolve_cookies() -> str | None:
    """cookies.txt da usare: un file già montato (YTDLP_COOKIES_FILE) o scritto da YTDLP_COOKIES. None = nessuno."""
    if COOKIES_FILE_ENV and Path(COOKIES_FILE_ENV).is_file():
        return COOKIES_FILE_ENV
    if _COOKIES_INLINE.strip():
        dest = Path("/tmp/ytdlp-cookies.txt")  # fuori da DOWNLOAD_DIR: lo sweep non lo tocca
        try:
            dest.write_text(_COOKIES_INLINE)
            dest.chmod(0o600)
            return str(dest)
        except OSError as exc:
            log.warning("impossibile scrivere il cookies file: %s", exc)
    return None


def _base_opts() -> dict:
    """Opzioni yt-dlp comuni a extract/serve, con anti-bot (cookies/client) e retry."""
    opts: dict = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "default_search": "ytsearch",
        "socket_timeout": 30,
        "retries": 3,
        "fragment_retries": 3,
    }
    clients = [c.strip() for c in PLAYER_CLIENT.split(",") if c.strip()]
    if clients:
        opts["extractor_args"] = {"youtube": {"player_client": clients}}
    if COOKIEFILE:
        opts["cookiefile"] = COOKIEFILE
    return opts


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
    global COOKIEFILE
    if MODE == "serve":
        DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    COOKIEFILE = _resolve_cookies()
    log.info(
        "avvio worker: mode=%s auth=%s cookies=%s player_client=%s max=%sMB",
        MODE,
        "on" if API_KEY else "OFF(APERTO!)",
        "si" if COOKIEFILE else "no",
        PLAYER_CLIENT or "default",
        MAX_FILESIZE_MB,
    )
    task = asyncio.create_task(_cleanup_loop()) if MODE == "serve" else None
    yield
    if task:
        task.cancel()


app = FastAPI(title="Solco yt-dlp worker", lifespan=lifespan)


@app.get("/health")
def health() -> dict:
    return {"ok": True, "mode": MODE, "cookies": bool(COOKIEFILE), "player_client": PLAYER_CLIENT or None}


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
    log.info("richiesta download: mode=%s target=%s", MODE, target[:200])
    result = (
        _serve_download(target, request, req.format)
        if MODE == "serve"
        else _extract_url(target, req.format)
    )
    log.info("download ok: title=%r ext=%s bytes=%s", result.get("title"), result.get("ext"), result.get("filesize"))
    return result


def _extract_url(target: str, fmt: str | None) -> dict:
    """Modalità extract: nessun download, solo l'URL diretto del media."""
    ydl_opts = {**_base_opts(), "skip_download": True, "format": fmt or FORMAT}
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = _pick_entry(ydl.extract_info(target, download=False))
    except Exception as exc:
        log.warning("extraction failed per %s: %s", target[:200], exc)
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


def _serve_download(target: str, request: Request, fmt: str | None) -> dict:
    """Modalità serve: scarica il media e restituisce un URL di questo worker (/file/<id>)."""
    _sweep()
    token = uuid.uuid4().hex
    ydl_opts = {
        **_base_opts(),
        "format": fmt or FORMAT,
        "outtmpl": str(DOWNLOAD_DIR / f"{token}.%(ext)s"),
        "max_filesize": MAX_FILESIZE_MB * 1024 * 1024,
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = _pick_entry(ydl.extract_info(target, download=True))
            path = Path(ydl.prepare_filename(info))
    except Exception as exc:
        log.warning("download failed per %s: %s", target[:200], exc)
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

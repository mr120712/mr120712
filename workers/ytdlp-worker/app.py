# Worker yt-dlp per il comando sperimentale /video del bot Telegram di Solco.
#
# Solco NON può eseguire yt-dlp (Vercel serverless), quindi delega QUI. Due modalità (WORKER_MODE):
#   - "extract" (default): ESTRAE l'URL diretto del media e lo restituisce (nessun file sul worker).
#       Veloce, senza storage; per YouTube l'URL può essere legato all'IP e a breve scadenza.
#   - "serve": SCARICA il media e lo SERVE da questo worker a /file/<id>, con pulizia automatica dopo
#       FILE_TTL_SECONDS. Robusto per YouTube (il link è del worker) e permette a Telegram di prelevarlo.
#
# SICUREZZA (cifratura "perfetta"):
#   - Trasporto: TLS end-to-end (Fly `force_https`), sia Solco→worker sia Telegram/utente→/file.
#   - Auth FAIL-CLOSED: senza WORKER_API_KEY il worker rifiuta tutto (503). Per test locali: WORKER_ALLOW_OPEN=1.
#   - Segreti (WORKER_API_KEY, YTDLP_COOKIES) cifrati a riposo come secret di Fly.
#   - Link /file FIRMATI (HMAC-SHA256 con WORKER_API_KEY) e a SCADENZA: non falsificabili né riusabili dopo il TTL.
# Uso consentito: contenuti tuoi o liberi — non elude DRM/paywall (yt-dlp non lo fa).
#
# YouTube da IP datacenter (Fly/Render/…) spesso risponde "Sign in to confirm you're not a bot".
# ANTI-BOT (vedi README):
#   1) RILEVA il controllo anti-bot e lo distingue dagli altri errori (codici: youtube_bot_check,
#      rate_limited, login_required, unavailable) → Solco può dire all'owner COSA fare.
#   2) RIPROVA da solo con altri client YouTube (YTDLP_FALLBACK_CLIENTS) e ricorda quello che passa.
#   3) SONDA: GET /antibot (con chiave) dice se questo worker supera il controllo, senza scaricare nulla.
# Leve via env:
#   - YTDLP_COOKIES          = contenuto di un cookies.txt (formato Netscape) → scritto su file e passato a yt-dlp
#   - YTDLP_COOKIES_FILE     = percorso a un cookies.txt già montato nel container (alternativa a YTDLP_COOKIES)
#     Su Render basta un «Secret File» chiamato cookies.txt (/etc/secrets/cookies.txt): è usato da solo.
#   - YTDLP_PLAYER_CLIENT    = client YouTube da forzare, CSV (es. "android" o "ios,web"); vuoto = default yt-dlp
#   - YTDLP_FALLBACK_CLIENTS = client da provare, uno alla volta, DOPO un controllo anti-bot; vuoto = nessuno
#   - YTDLP_PROXY            = proxy in uscita per yt-dlp (es. residenziale); è un SEGRETO se contiene credenziali
import asyncio
import hashlib
import hmac
import logging
import mimetypes
import os
import re
import time
import uuid
from collections.abc import Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import yt_dlp
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel
from yt_dlp.cookies import YoutubeDLCookieJar

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("ytdlp-worker")

# Chiave/segreto condiviso: WORKER_API_KEY (preferito) oppure YTDLP_SERVICE_KEY come alias — così lo
# STESSO nome usato su Vercel (YTDLP_SERVICE_KEY) vale anche qui, evitando errori di naming fra i due lati.
API_KEY = (os.environ.get("WORKER_API_KEY") or os.environ.get("YTDLP_SERVICE_KEY") or "").strip()
# Fail-closed: senza chiave il worker rifiuta tutto, a meno di questo opt-in esplicito (solo dev locale).
ALLOW_OPEN = os.environ.get("WORKER_ALLOW_OPEN", "").strip().lower() in {"1", "true", "yes", "on"}
MODE = os.environ.get("WORKER_MODE", "extract").strip().lower()
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "").strip().rstrip("/")
FILE_TTL_SECONDS = int(os.environ.get("FILE_TTL_SECONDS", "900"))
MAX_FILESIZE_MB = int(os.environ.get("MAX_FILESIZE_MB", "200"))
DOWNLOAD_DIR = Path(os.environ.get("DOWNLOAD_DIR", "/tmp/ytdlp-serve"))
PLAYER_CLIENT = os.environ.get("YTDLP_PLAYER_CLIENT", "").strip()
COOKIES_FILE_ENV = os.environ.get("YTDLP_COOKIES_FILE", "").strip()
_COOKIES_INLINE = os.environ.get("YTDLP_COOKIES", "")
# Render «Secret Files»: un file chiamato cookies.txt viene montato qui e usato da solo, senza altre variabili.
SECRET_COOKIES_PATH = "/etc/secrets/cookies.txt"
# La copia scrivibile e normalizzata che yt-dlp usa davvero (fuori da DOWNLOAD_DIR: lo sweep non la tocca).
COOKIES_RUNTIME_PATH = Path("/tmp/ytdlp-cookies.txt")
# Esito del caricamento dei cookie, senza segreti (mostrato in /health).
COOKIES_INFO: dict[str, Any] = {"source": None, "count": 0, "youtube": False, "skipped": 0, "error": None}


def _csv(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


# Anti-bot: client YouTube provati UNO ALLA VOLTA quando il tentativo normale riceve il controllo anti-bot.
# È un tentativo a costo zero, non una garanzia: se l'IP è bloccato servono i cookie o un proxy.
FALLBACK_CLIENTS = _csv(os.environ.get("YTDLP_FALLBACK_CLIENTS", "tv,android_vr,web_safari,mweb"))
# Tempo massimo oltre il quale non si INIZIANO altri tentativi (il bot di Solco aspetta 40s in tutto).
ANTIBOT_BUDGET_SECONDS = float(os.environ.get("YTDLP_ANTIBOT_BUDGET_SECONDS", "25"))
PROXY = os.environ.get("YTDLP_PROXY", "").strip()
# Video pubblico e stabile usato dalla sonda GET /antibot (solo estrazione, nessun download).
PROBE_URL = os.environ.get("YTDLP_PROBE_URL", "https://www.youtube.com/watch?v=jNQXAC9IVRw").strip()

# Formato pre-muxato (audio+video insieme): evita il merge ffmpeg e dà un singolo file/URL riproducibile.
FORMAT = "best[acodec!=none][vcodec!=none]/best"

# Risolto una volta allo startup (lifespan): percorso a un cookies.txt usabile, o None.
COOKIEFILE: str | None = None

# Stato anti-bot del processo: il client che ha superato il controllo (riusato per primo) e l'ultimo esito.
_PREFERRED_CLIENT: str | None = None
_LAST_OUTCOME: dict[str, Any] = {"status": None, "client": None, "at": None}

# Cosa fare per ogni esito (mostrato dalla sonda /antibot).
_HINTS = {
    "ok": "YouTube risponde: nessun controllo anti-bot per questo worker.",
    "youtube_bot_check": (
        "L'IP del worker è fermato dal controllo anti-bot. Imposta YTDLP_COOKIES (cookies.txt di un "
        "account YouTube, meglio secondario) oppure YTDLP_PROXY, poi ridistribuisci."
    ),
    "rate_limited": "YouTube sta limitando questo IP (troppe richieste): aspetta, o usa YTDLP_PROXY.",
    "login_required": "Il contenuto richiede un accesso: imposta YTDLP_COOKIES.",
    "unavailable": "Il video di prova non è disponibile da questo worker: cambia YTDLP_PROBE_URL.",
    "failed": "Errore non riconosciuto: guarda i log del worker per il motivo preciso di yt-dlp.",
}


class UpstreamFailure(Exception):
    """yt-dlp non è riuscito. `kind` è un codice stabile (_classify_error), `tried` i client provati."""

    def __init__(self, kind: str, tried: list[str]):
        super().__init__(kind)
        self.kind = kind
        self.tried = tried


class DownloadRequest(BaseModel):
    url: str | None = None
    query: str | None = None
    format: str | None = None


_NETSCAPE_HEADER = "# Netscape HTTP Cookie File"
# Un record del formato Netscape quando i TAB sono andati persi (incollato in un campo web):
# dominio, flag, percorso, secure, scadenza, nome, valore — separati da spazi.
_COOKIE_RECORD = re.compile(
    r"(\S+)[ \t]+(TRUE|FALSE)[ \t]+(\S+)[ \t]+(TRUE|FALSE)[ \t]+(\d+)[ \t]+(\S+)[ \t]*(\S*)"
)


def _normalize_cookies(text: str) -> tuple[str, int]:
    """Rende leggibile a yt-dlp un cookies.txt passato per un campo web. Ritorna (testo, righe scartate).

    yt-dlp vuole l'intestazione Netscape e 7 campi separati da TAB; altrimenti SCARTA le righe in
    silenzio (0 cookie caricati) e le stampa nei log, valori compresi. Qui si sistemano fine riga
    Windows, TAB diventati spazi, righe fuse in una sola e intestazione mancante; ciò che resta
    illeggibile viene tolto, così nessun valore di cookie finisce mai nei log.
    """
    records: list[str] = []
    skipped = 0
    for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = raw.strip(" ")
        if not line.strip():
            continue
        if "\t" in line:
            fields = line.split("\t")
            if len(fields) == 6:
                fields.append("")  # valore vuoto: il TAB finale si perde facilmente
            if len(fields) == 7 and (not line.startswith("#") or line.startswith("#HttpOnly_")):
                records.append("\t".join(fields))
            elif not line.startswith("#"):
                skipped += 1
            continue
        found = ["\t".join(match.groups()) for match in _COOKIE_RECORD.finditer(line)]
        if found:
            records.extend(found)
        elif not line.startswith("#"):
            skipped += 1
    return "\n".join([_NETSCAPE_HEADER, *records]) + "\n", skipped


def _cookie_source() -> tuple[str, str] | None:
    """(origine, testo) dei cookie, in ordine: YTDLP_COOKIES_FILE, YTDLP_COOKIES, Secret File di Render."""

    def read(path: str) -> str | None:
        if not path or not Path(path).is_file():
            return None
        try:
            return Path(path).read_text(errors="replace")
        except OSError as exc:
            log.warning("cookies: impossibile leggere %s: %s", path, exc)
            return None

    text = read(COOKIES_FILE_ENV)
    if text is not None:
        return "file", text
    if _COOKIES_INLINE.strip():
        return "env", _COOKIES_INLINE
    text = read(SECRET_COOKIES_PATH)
    return ("secret-file", text) if text is not None else None


def _resolve_cookies() -> str | None:
    """Prepara i cookie per yt-dlp e ritorna il percorso da usare (None = nessun cookie valido).

    Si lavora SEMPRE su una copia scrivibile: yt-dlp riscrive il file a fine lavoro e i secret file
    montati sono in sola lettura. La copia è normalizzata e poi verificata caricandola davvero; l'esito
    (quanti cookie, se ce ne sono di YouTube) va in COOKIES_INFO, visibile in /health senza segreti.
    """
    COOKIES_INFO.update(source=None, count=0, youtube=False, skipped=0, error=None)
    source = _cookie_source()
    if not source:
        return None
    label, text = source
    normalized, skipped = _normalize_cookies(text)
    COOKIES_INFO.update(source=label, skipped=skipped)
    try:
        COOKIES_RUNTIME_PATH.parent.mkdir(parents=True, exist_ok=True)
        COOKIES_RUNTIME_PATH.write_text(normalized)
        COOKIES_RUNTIME_PATH.chmod(0o600)
        jar = YoutubeDLCookieJar(str(COOKIES_RUNTIME_PATH))
        jar.load()
        cookies = list(jar)
    except Exception as exc:  # file non scrivibile o formato che yt-dlp rifiuta (es. JSON)
        COOKIES_INFO.update(error=f"cookie non caricati: {type(exc).__name__}")
        log.warning("cookies (%s): non caricati: %s", label, type(exc).__name__)
        return None
    youtube = any("youtube.com" in (cookie.domain or "") for cookie in cookies)
    COOKIES_INFO.update(count=len(cookies), youtube=youtube)
    if not cookies:
        COOKIES_INFO.update(error="nessun cookie valido: serve un cookies.txt in formato Netscape")
        log.warning("cookies (%s): nessun cookie valido (righe scartate: %s)", label, skipped)
        return None
    log.info("cookies (%s): %s caricati, YouTube=%s, righe scartate=%s", label, len(cookies), youtube, skipped)
    return str(COOKIES_RUNTIME_PATH)


def _base_opts() -> dict:
    """Opzioni yt-dlp comuni a extract/serve: retry, cookie e proxy. Il client YouTube lo sceglie
    _run_with_antibot, tentativo per tentativo."""
    opts: dict = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "default_search": "ytsearch",
        "socket_timeout": 30,
        "retries": 3,
        "fragment_retries": 3,
    }
    if COOKIEFILE:
        opts["cookiefile"] = COOKIEFILE
    if PROXY:
        opts["proxy"] = PROXY
    return opts


def _redact(text: str) -> str:
    """Toglie dai log l'URL del proxy (può contenere utente e password)."""
    if not PROXY:
        return text
    text = text.replace(PROXY, "[proxy]")
    password = urlsplit(PROXY).password
    return text.replace(password, "***") if password else text


def _classify_error(exc: BaseException) -> str:
    """Riduce l'errore di yt-dlp a un codice stabile. L'ordine conta: il controllo anti-bot contiene
    anche "Sign in", quindi va riconosciuto PRIMA del login generico."""
    text = str(exc).replace("’", "'").lower()
    if "not a bot" in text:
        return "youtube_bot_check"
    if "http error 429" in text or "too many requests" in text or "try again later" in text:
        return "rate_limited"
    if (
        "sign in" in text
        or "login required" in text
        or "members-only" in text
        or "private video" in text
    ):
        return "login_required"
    if (
        "video unavailable" in text
        or "is unavailable" in text
        or "has been removed" in text
        or "not available in your country" in text
    ):
        return "unavailable"
    return "failed"


def _client_plan() -> list[tuple[str, list[str] | None]]:
    """Ordine dei tentativi: il client che ha già superato l'anti-bot, poi la configurazione
    (YTDLP_PLAYER_CLIENT, o il default di yt-dlp), poi i fallback. Senza doppioni."""
    configured = _csv(PLAYER_CLIENT)
    plan: list[tuple[str, list[str] | None]] = []

    def add(label: str, clients: list[str] | None) -> None:
        if all(existing != label for existing, _ in plan):
            plan.append((label, clients))

    if _PREFERRED_CLIENT:
        add(_PREFERRED_CLIENT, [_PREFERRED_CLIENT])
    add(",".join(configured) if configured else "default", configured or None)
    for client in FALLBACK_CLIENTS:
        add(client, [client])
    return plan


def _note_outcome(status: str, client: str | None) -> None:
    _LAST_OUTCOME.update(status=status, client=client, at=int(time.time()))


def _run_with_antibot(
    opts: dict,
    work: Callable[[Any], Any],
    cleanup: Callable[[], None] | None = None,
) -> tuple[Any, list[str]]:
    """Esegue `work(ydl)`; se YouTube risponde col controllo anti-bot riprova con i client di fallback.

    Ritorna (risultato, client provati — l'ultimo è quello riuscito). Solleva UpstreamFailure con il
    codice dell'ULTIMO errore. Solo il controllo anti-bot fa cambiare client: video rimosso, 429 o login
    non si risolvono così e fermano subito i tentativi.
    """
    global _PREFERRED_CLIENT
    deadline = time.monotonic() + ANTIBOT_BUDGET_SECONDS
    tried: list[str] = []
    kind = "failed"
    for label, clients in _client_plan():
        if tried and time.monotonic() >= deadline:
            log.warning("anti-bot: budget di %.0fs esaurito dopo %s", ANTIBOT_BUDGET_SECONDS, tried)
            break
        attempt = dict(opts)
        if clients:
            attempt["extractor_args"] = {"youtube": {"player_client": clients}}
        tried.append(label)
        try:
            with yt_dlp.YoutubeDL(attempt) as ydl:
                result = work(ydl)
        except Exception as exc:  # yt-dlp mette il motivo nel testo di DownloadError/ExtractorError
            kind = _classify_error(exc)
            log.warning("yt-dlp fallito (client=%s, esito=%s): %s", label, kind, _redact(str(exc))[:300])
            if cleanup:
                cleanup()
            if kind != "youtube_bot_check":
                break
            if label == _PREFERRED_CLIENT:
                _PREFERRED_CLIENT = None  # non passa più: si riparte dalla configurazione
            continue
        if len(tried) > 1 and clients and len(clients) == 1:
            _PREFERRED_CLIENT = clients[0]
            log.info("anti-bot: superato con il client %s (dopo %s)", label, tried[:-1])
        _note_outcome("ok", label)
        return result, tried
    _note_outcome(kind, tried[-1] if tried else None)
    raise UpstreamFailure(kind, tried)


def _upstream_http(failure: UpstreamFailure, generic: str) -> HTTPException:
    """502 con `detail` = codice riconosciuto (es. youtube_bot_check) o il messaggio generico di prima."""
    return HTTPException(status_code=502, detail=generic if failure.kind == "failed" else failure.kind)


def _check_auth(authorization: str | None) -> None:
    # FAIL-CLOSED: senza WORKER_API_KEY il worker RIFIUTA tutto (503), a meno di WORKER_ALLOW_OPEN=1
    # (solo per test locali). Così non resta mai pubblico per sbaglio.
    if not API_KEY:
        if ALLOW_OPEN:
            return
        raise HTTPException(status_code=503, detail="worker not configured: set WORKER_API_KEY")
    expected = f"Bearer {API_KEY}"
    if not authorization or not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="unauthorized")


def _sign(name: str, exp: int) -> str:
    """Firma HMAC-SHA256 (con WORKER_API_KEY) di <name>:<exp>: lega il link al file e alla scadenza."""
    return hmac.new(API_KEY.encode(), f"{name}:{exp}".encode(), hashlib.sha256).hexdigest()


def _signed_path(name: str) -> str:
    """URL del file: con la chiave è FIRMATO e a SCADENZA (?exp&sig); senza (solo dev) è nudo."""
    if not API_KEY:
        return f"/file/{name}"
    exp = int(time.time()) + FILE_TTL_SECONDS
    return f"/file/{name}?exp={exp}&sig={_sign(name, exp)}"


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
    auth_state = "required" if API_KEY else ("open(DEV!)" if ALLOW_OPEN else "UNCONFIGURED→503")
    log.info(
        "avvio worker: mode=%s auth=%s cookies=%s proxy=%s player_client=%s fallback=%s max=%sMB",
        MODE,
        auth_state,
        "si" if COOKIEFILE else "no",
        "si" if PROXY else "no",
        PLAYER_CLIENT or "default",
        ",".join(FALLBACK_CLIENTS) or "nessuno",
        MAX_FILESIZE_MB,
    )
    if not API_KEY and not ALLOW_OPEN:
        log.warning("WORKER_API_KEY non impostata: ogni richiesta risponderà 503 finché non la imposti.")
    task = asyncio.create_task(_cleanup_loop()) if MODE == "serve" else None
    yield
    if task:
        task.cancel()


app = FastAPI(title="Solco yt-dlp worker", lifespan=lifespan)


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "mode": MODE,
        "auth": "required" if API_KEY else ("open" if ALLOW_OPEN else "unconfigured"),
        "cookies": bool(COOKIEFILE),
        # Esito del caricamento dei cookie (origine, quanti, se di YouTube): mai nomi o valori.
        "cookies_info": dict(COOKIES_INFO),
        "player_client": PLAYER_CLIENT or None,
        # Stato anti-bot (nessun segreto): le leve attive e l'esito dell'ULTIMA richiesta a monte.
        "antibot": {
            "fallback_clients": FALLBACK_CLIENTS,
            "preferred_client": _PREFERRED_CLIENT,
            "proxy": bool(PROXY),
            "last": dict(_LAST_OUTCOME),
        },
    }


@app.get("/antibot")
def antibot(authorization: str | None = Header(default=None)) -> dict:
    """Sonda anti-bot: ESTRAE (senza scaricare) un video pubblico di YouTube e dice se questo worker
    supera il controllo. Richiede la chiave come /download, perché genera traffico in uscita."""
    _check_auth(authorization)
    started = time.monotonic()
    try:
        # process=False: basta la risposta del player (dove scatta il controllo), niente scelta formati.
        _, tried = _run_with_antibot(
            _base_opts(),
            lambda ydl: ydl.extract_info(PROBE_URL, download=False, process=False),
        )
        status = "ok"
    except UpstreamFailure as failure:
        status, tried = failure.kind, failure.tried
    return {
        "youtube": status,
        "client": tried[-1] if status == "ok" and tried else None,
        "tried": tried,
        "cookies": bool(COOKIEFILE),
        "proxy": bool(PROXY),
        "seconds": round(time.monotonic() - started, 1),
        "hint": _HINTS.get(status, _HINTS["failed"]),
    }


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
        info, _ = _run_with_antibot(
            ydl_opts, lambda ydl: _pick_entry(ydl.extract_info(target, download=False))
        )
    except UpstreamFailure as failure:
        log.warning("extraction failed per %s: %s (client provati: %s)", target[:200], failure.kind, failure.tried)
        raise _upstream_http(failure, "extraction failed") from None

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
    """Modalità serve: scarica il media e restituisce un URL FIRMATO di questo worker (/file/<id>?exp&sig)."""
    _sweep()
    token = uuid.uuid4().hex
    ydl_opts = {
        **_base_opts(),
        "format": fmt or FORMAT,
        "outtmpl": str(DOWNLOAD_DIR / f"{token}.%(ext)s"),
        "max_filesize": MAX_FILESIZE_MB * 1024 * 1024,
    }

    def work(ydl: Any) -> tuple[dict, Path]:
        entry = _pick_entry(ydl.extract_info(target, download=True))
        return entry, Path(ydl.prepare_filename(entry))

    def cleanup() -> None:
        # Un tentativo fallito può lasciare file parziali: via prima di riprovare con un altro client.
        for leftover in DOWNLOAD_DIR.glob(f"{token}.*"):
            try:
                leftover.unlink()
            except OSError:
                pass

    try:
        (info, path), _ = _run_with_antibot(ydl_opts, work, cleanup)
    except UpstreamFailure as failure:
        log.warning("download failed per %s: %s (client provati: %s)", target[:200], failure.kind, failure.tried)
        raise _upstream_http(failure, "download failed") from None

    if not path.is_file():
        # max_filesize superato o nessun formato scaricabile.
        raise HTTPException(status_code=413, detail="file too large or not downloadable")

    base = PUBLIC_BASE_URL or str(request.base_url).rstrip("/")
    duration = info.get("duration")
    return {
        "url": f"{base}{_signed_path(path.name)}",
        "title": info.get("title"),
        "ext": info.get("ext"),
        "durationSeconds": int(duration) if isinstance(duration, (int, float)) else None,
        "filesize": path.stat().st_size,
    }


@app.get("/file/{name}")
def serve_file(name: str, exp: int | None = None, sig: str | None = None) -> FileResponse:
    # Solo un nome di file semplice dentro DOWNLOAD_DIR: niente "/" né "..".
    if "/" in name or "\\" in name or name in ("", ".", ".."):
        raise HTTPException(status_code=400, detail="bad name")
    # Link FIRMATO e a SCADENZA quando c'è la chiave (fail-closed, come /download).
    if API_KEY:
        if exp is None or not sig:
            raise HTTPException(status_code=403, detail="missing signature")
        if time.time() > exp:
            raise HTTPException(status_code=403, detail="link expired")
        if not hmac.compare_digest(sig, _sign(name, exp)):
            raise HTTPException(status_code=403, detail="bad signature")
    elif not ALLOW_OPEN:
        raise HTTPException(status_code=503, detail="worker not configured")
    path = (DOWNLOAD_DIR / name).resolve()
    if DOWNLOAD_DIR.resolve() not in path.parents or not path.is_file():
        raise HTTPException(status_code=404, detail="not found")
    media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return FileResponse(path, media_type=media_type, filename=path.name)

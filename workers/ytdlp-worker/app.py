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
#   - YTDLP_PROXY            = proxy in uscita per yt-dlp (es. residenziale); è un SEGRETO se contiene credenziali.
#     Accetta l'URL (http://utente:password@host:porta, anche socks5://) e i formati dei fornitori
#     (host:porta:utente:password, utente:password:host:porta). /health → antibot.proxy_info dice se è stato letto.
#   - YTDLP_WARP             = 1 per avere un'uscita di riserva GRATUITA da Cloudflare WARP: quando l'IP del
#     worker riceve il controllo anti-bot, yt-dlp riprova da lì. Misurato dal vivo da un IP da datacenter: è la
#     sola leva senza costi che passa (gli altri client e i PO Token no). Spenta di default: accenderla vale
#     come accettare i termini di Cloudflare per WARP, e il client è «usque», open-source e non ufficiale.
import asyncio
import hashlib
import hmac
import json
import logging
import mimetypes
import os
import pwd
import re
import shutil
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid
from collections.abc import Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote, urlsplit

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
# Seconda chiave valida (rotazione senza downtime): WORKER_API_KEY_2 (alias YTDLP_SERVICE_KEY2). Vale solo
# per l'Authorization: i link /file restano firmati con la chiave principale (li firma e verifica il worker).
API_KEY_2 = (os.environ.get("WORKER_API_KEY_2") or os.environ.get("YTDLP_SERVICE_KEY2") or "").strip()
# Fail-closed: senza chiave il worker rifiuta tutto, a meno di questo opt-in esplicito (solo dev locale).
ALLOW_OPEN = os.environ.get("WORKER_ALLOW_OPEN", "").strip().lower() in {"1", "true", "yes", "on"}
MODE = os.environ.get("WORKER_MODE", "extract").strip().lower()
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "").strip().rstrip("/")
FILE_TTL_SECONDS = int(os.environ.get("FILE_TTL_SECONDS", "900"))
MAX_FILESIZE_MB = int(os.environ.get("MAX_FILESIZE_MB", "200"))
# Download contemporanei: su Render free (0,1 CPU, 512 MB) due yt-dlp + ffmpeg insieme rischiano di
# finire la memoria. Oltre il limite si risponde subito 503 + Retry-After invece di rallentare tutti.
MAX_CONCURRENT_DOWNLOADS = max(1, int(os.environ.get("MAX_CONCURRENT_DOWNLOADS", "2")))
# Secondi che yt-dlp aspetta un socket fermo prima di rinunciare (prima 30): una connessione appesa
# dietro WARP non deve mangiarsi i 40 s che il bot di Solco concede a una richiesta.
SOCKET_TIMEOUT_SECONDS = float(os.environ.get("YTDLP_SOCKET_TIMEOUT", "15"))
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


# Anti-bot: client YouTube provati UNO ALLA VOLTA quando il tentativo normale non dà il file.
# L'elenco viene da una misura (vedi README): su un'uscita pulita questi danno un file unico audio+video,
# mentre «tv» risponde «The page needs to be reloaded» e «web_safari»/«visionos» non hanno quel formato.
# Contro un IP fermato dal controllo anti-bot non bastano: lì serve cambiare uscita (WARP, proxy) o i cookie.
FALLBACK_CLIENTS = _csv(os.environ.get("YTDLP_FALLBACK_CLIENTS", "tv_samsung,mweb,android_vr,web_embedded"))
# Tempo massimo oltre il quale non si INIZIANO altri tentativi (il bot di Solco aspetta 40s in tutto).
ANTIBOT_BUDGET_SECONDS = float(os.environ.get("YTDLP_ANTIBOT_BUDGET_SECONDS", "25"))
_PROXY_SCHEMES = {"http", "https", "socks4", "socks4a", "socks5", "socks5h"}
_PROXY_HOSTPORT = re.compile(r"([A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\]):(\d{1,5})")
# Quanto si aspetta che il proxy accetti la connessione, prima di ogni lavoro di yt-dlp.
PROXY_CONNECT_TIMEOUT = float(os.environ.get("YTDLP_PROXY_CONNECT_TIMEOUT", "5"))


def _hostport(value: str) -> tuple[str, int] | None:
    match = _PROXY_HOSTPORT.fullmatch(value)
    port = int(match[2]) if match else 0
    return (match[1], port) if match and 0 < port < 65536 else None


def _normalize_proxy(raw: str) -> tuple[str, str | None]:
    """(URL del proxy per yt-dlp, errore). Accetta l'URL classico e i formati in cui i fornitori
    consegnano le credenziali — `host:porta:utente:password`, `utente:password:host:porta`,
    `utente:password@host:porta`, `host:porta` — e li riscrive `schema://utente:password@host:porta`
    con le credenziali codificate (un «@» o un «:» nella password spezzerebbero l'URL).

    Un valore non interpretabile dà URL vuoto + il motivo: meglio nessun proxy che ogni richiesta
    fallita. Il motivo finisce in /health, quindi non contiene MAI il valore."""
    value = raw.strip().strip("\"'` ")
    if not value:
        return "", None
    scheme, separator, rest = value.partition("://")
    if not separator:
        scheme, rest = "http", value
    scheme = scheme.lower()
    if scheme not in _PROXY_SCHEMES:
        return "", "schema non supportato: usa http, https, socks4 o socks5"

    def build(target: tuple[str, int], user: str | None, password: str | None) -> tuple[str, None]:
        auth = ""
        if user is not None:
            secret = "" if password is None else f":{quote(password, safe='')}"
            auth = f"{quote(user, safe='')}{secret}@"
        return f"{scheme}://{auth}{target[0]}:{target[1]}", None

    userinfo, at, tail = rest.rpartition("@")
    target = _hostport(tail.rstrip("/"))
    if target and at:  # utente[:password]@host:porta — forma URL: le credenziali possono essere già codificate
        user, colon, password = userinfo.partition(":")
        return build(target, unquote(user), unquote(password) if colon else None)
    if target:  # host:porta
        return build(target, None, None)
    parts = rest.split(":")
    if len(parts) >= 4:
        head = _hostport(":".join(parts[:2]))
        last = _hostport(":".join(parts[-2:]).rstrip("/"))
        # Se reggono entrambe le letture (password di sole cifre) vince quella con un host «vero».
        if head and last and "." not in head[0] and "." in last[0]:
            head = None
        if head:  # host:porta:utente:password
            return build(head, parts[2], ":".join(parts[3:]))
        if last:  # utente:password:host:porta
            return build(last, parts[0], ":".join(parts[1:-2]))
    return "", "formato non riconosciuto: usa http://utente:password@host:porta"


def _first_proxy(raw: str) -> tuple[str, str | None, int]:
    """(URL, errore, voci ignorate). I fornitori fanno scaricare ELENCHI, una riga per proxy: se in
    YTDLP_PROXY ne arriva uno si usa il primo proxy leggibile, sempre lo stesso (YouTube lega i link
    del media all'IP che li ha chiesti: cambiare proxy a metà lavoro li invaliderebbe)."""
    entries = raw.split()
    first_error: str | None = None
    for entry in entries:
        url, error = _normalize_proxy(entry)
        if url:
            return url, None, len(entries) - 1
        first_error = first_error or error
    return "", first_error, 0


PROXY, PROXY_ERROR, PROXY_IGNORED = _first_proxy(os.environ.get("YTDLP_PROXY", ""))
# Uscita da Cloudflare WARP (vedi WarpExit): solo se accesa con YTDLP_WARP=1, e mai insieme a YTDLP_PROXY.
WARP_ENABLED = os.environ.get("YTDLP_WARP", "").strip().lower() in {"1", "true", "yes", "on"}
WARP_BIN = os.environ.get("YTDLP_WARP_BIN", "").strip() or "usque"
WARP_DIR = Path(os.environ.get("YTDLP_WARP_DIR", "/tmp/ytdlp-warp"))
WARP_PORT = int(os.environ.get("YTDLP_WARP_PORT", "40000"))
# Quanto si aspetta, per ciascun trasporto, che il tunnel porti traffico dopo l'avvio del client.
WARP_READY_SECONDS = float(os.environ.get("YTDLP_WARP_READY_SECONDS", "20"))
# Quanto una richiesta aspetta un tunnel che sta ancora partendo (worker appena svegliato), prima di
# ripiegare sull'uscita diretta: deve restare tempo per scaricare entro i 40 secondi del bot.
WARP_WAIT_SECONDS = float(os.environ.get("YTDLP_WARP_WAIT_SECONDS", "15"))
# Quante volte, in una richiesta, si cambia indirizzo di uscita quando YouTube ferma quello in uso.
# Nelle misure è fermato circa un indirizzo su tre, e cambiarlo costa poco più di un secondo: con 5
# cambi la probabilità di trovare solo indirizzi fermati scende sotto lo 0,1%. Il budget della richiesta
# (YTDLP_ANTIBOT_BUDGET_SECONDS) resta il limite vero: oltre, non si inizia un altro tentativo.
WARP_RENEWALS = int(os.environ.get("YTDLP_WARP_RENEWALS", "5"))
# Margine lasciato a un tentativo di yt-dlp quando si aspetta il tunnel: sotto, non vale la pena.
WARP_MIN_ATTEMPT_SECONDS = float(os.environ.get("YTDLP_WARP_MIN_ATTEMPT_SECONDS", "3"))
WARP_IGNORED = "non usata: c'è YTDLP_PROXY, che è l'uscita scelta dall'owner"
# Video pubblico e stabile usato dalla sonda GET /antibot (solo estrazione, nessun download).
PROBE_URL = os.environ.get("YTDLP_PROBE_URL", "https://www.youtube.com/watch?v=jNQXAC9IVRw").strip()

# Formato pre-muxato (audio+video insieme): evita il merge ffmpeg e dà un singolo file/URL riproducibile.
FORMAT = "best[acodec!=none][vcodec!=none]/best"

# Risolto una volta allo startup (lifespan): percorso a un cookies.txt usabile, o None.
COOKIEFILE: str | None = None

# Stato anti-bot del processo: il client che ha superato il controllo (riusato per primo) e l'ultimo esito.
_PREFERRED_CLIENT: str | None = None
_LAST_OUTCOME: dict[str, Any] = {
    "status": None,
    "client": None,
    "exit": None,
    "attempts": None,
    "seconds": None,
    "at": None,
}

# Cosa fare per ogni esito (mostrato dalla sonda /antibot).
_HINTS = {
    "ok": "YouTube risponde: nessun controllo anti-bot per questo worker.",
    "youtube_bot_check": (
        "L'IP del worker è fermato dal controllo anti-bot. Accendi l'uscita gratuita da Cloudflare WARP "
        "(YTDLP_WARP=1), oppure imposta YTDLP_PROXY o YTDLP_COOKIES (cookies.txt di un account YouTube, "
        "meglio secondario), poi ridistribuisci."
    ),
    "media_unavailable": (
        "YouTube risponde ma nessun client ha dato un file scaricabile: di solito passa riprovando; "
        "se persiste, aggiorna yt-dlp ricostruendo l'immagine."
    ),
    "rate_limited": "YouTube sta limitando questo IP (troppe richieste): aspetta, o usa YTDLP_PROXY.",
    "proxy_unreachable": (
        "Il proxy di YTDLP_PROXY non accetta connessioni: controlla host e porta, e che il servizio sia attivo."
    ),
    "proxy_error": (
        "Il proxy di YTDLP_PROXY ha rifiutato la richiesta: controlla utente e password, il credito "
        "residuo e che il piano consenta YouTube."
    ),
    "login_required": "Il contenuto richiede un accesso: imposta YTDLP_COOKIES.",
    "unavailable": "Il video di prova non è disponibile da questo worker: cambia YTDLP_PROBE_URL.",
    "failed": "Errore non riconosciuto: guarda i log del worker per il motivo preciso di yt-dlp.",
}


def _active_levers(warp: str | None = None) -> list[str]:
    """Le leve anti-bot GIÀ attive su questo worker, nell'ordine usato nei codici
    (`+cookies+proxy`, `+warp`, `+warp_down`). `warp` è la sorte dell'uscita WARP in quel tentativo:
    «blocked» = fermata anche lei, «down» = accesa ma non disponibile."""
    levers = [name for name, active in (("cookies", COOKIEFILE), ("proxy", PROXY)) if active]
    if warp:
        levers.append("warp" if warp == "blocked" else "warp_down")
    return levers


def _hint(status: str, warp: str | None = None) -> str:
    """Cosa fare per l'esito. Se il controllo anti-bot scatta con delle leve GIÀ attive, il consiglio
    non è "impostale" ma cosa non va in quelle che ci sono."""
    levers = _active_levers(warp)
    if status != "youtube_bot_check" or not levers:
        return _HINTS.get(status, _HINTS["failed"])
    advice = {
        "cookies": "i cookie sono scaduti o l'account è stato segnalato: riesporta cookies.txt",
        "proxy": (
            "l'IP del proxy è bloccato come quello del worker: serve un proxy residenziale o mobile, "
            "non datacenter"
        ),
        "warp": (
            "anche l'uscita da Cloudflare WARP è fermata: di solito passa riprovando più tardi, "
            "altrimenti restano i cookie o un proxy residenziale"
        ),
        "warp_down": (
            "l'uscita da Cloudflare WARP è accesa ma non disponibile (motivo in /health → antibot.warp): "
            "riprova fra un minuto"
        ),
    }
    return "Il controllo anti-bot scatta lo stesso — " + "; ".join(advice[lever] for lever in levers) + "."


class UpstreamFailure(Exception):
    """yt-dlp non è riuscito. `kind` è un codice stabile (_classify_error), `tried` i tentativi fatti,
    `warp` la sorte dell'uscita WARP quando è accesa: «down» (non disponibile) o «blocked» (fermata)."""

    def __init__(self, kind: str, tried: list[str], warp: str | None = None):
        super().__init__(kind)
        self.kind = kind
        self.tried = tried
        self.warp = warp


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


class _SilentLogger:
    """yt-dlp scriverebbe ogni errore su stderr così com'è. Qui tace: _run_with_antibot registra già
    lo stesso errore, una volta sola e passato da _redact (nessuna credenziale del proxy nei log)."""

    def debug(self, _message: str) -> None:
        pass

    info = warning = error = debug


def _base_opts() -> dict:
    """Opzioni yt-dlp comuni a extract/serve: retry, cookie e proxy. Il client YouTube lo sceglie
    _run_with_antibot, tentativo per tentativo."""
    opts: dict = {
        "quiet": True,
        "no_warnings": True,
        "logger": _SilentLogger(),
        "noplaylist": True,
        "default_search": "ytsearch",
        "socket_timeout": SOCKET_TIMEOUT_SECONDS,
        "retries": 3,
        "fragment_retries": 3,
    }
    if COOKIEFILE:
        opts["cookiefile"] = COOKIEFILE
    if PROXY:
        opts["proxy"] = PROXY
    return opts


def _redact(text: str) -> str:
    """Toglie dai log l'URL del proxy e le sue credenziali (anche nella forma non codificata)."""
    if not PROXY:
        return text
    text = text.replace(PROXY, "[proxy]")
    parsed = urlsplit(PROXY)
    secrets = [parsed.password or ""]
    if len(parsed.username or "") >= 6:  # uno username corto sporcherebbe parole innocue dei log
        secrets.append(parsed.username or "")
    for secret in filter(None, secrets):
        for form in {secret, unquote(secret)}:
            text = text.replace(form, "***")
    return text


class _WarpError(Exception):
    """Perché l'uscita WARP non è partita: frase breve e senza segreti, mostrata in /health."""


def _warp_command() -> list[str]:
    """Come viene avviato il client: modalità «l4-socks», cioè il proxy di Cloudflare aperto connessione
    per connessione, su QUIC (UDP 443). È una scelta misurata: da lì YouTube risponde, mentre dalla
    modalità «socks» — un tunnel IP completo, che esce da altri indirizzi — arriva lo stesso controllo
    anti-bot dell'IP del worker, sia su QUIC sia su HTTP/2. Pronta in 3 secondi, 19 MB di memoria.
    Il SOCKS ascolta solo su 127.0.0.1: non è raggiungibile da fuori dal container."""
    return ["l4-socks", "-b", "127.0.0.1", "-p", str(WARP_PORT), "--system-dns"]


# Attesa prima di riprovare dopo un avvio fallito: breve la prima volta, poi sempre più rada.
_WARP_RETRY_SECONDS = (5, 30, 120, 600)
_TOKEN = re.compile(r"[A-Za-z0-9+/=_-]{24,}")


def _port_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            return True
    except OSError:
        return False


def _warp_trace(proxy: str) -> dict[str, str] | None:
    """Una richiesta vera attraverso il SOCKS: Cloudflare dice se arriva da WARP («warp=on») e da quale
    sua sede («colo»). È la prova che il tunnel porta traffico, non solo che la porta è aperta.
    Ritorna i campi della risposta, o None se la richiesta non passa o non esce da WARP."""
    opts = {"quiet": True, "no_warnings": True, "logger": _SilentLogger(), "proxy": proxy, "socket_timeout": 8}
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            body = ydl.urlopen("https://www.cloudflare.com/cdn-cgi/trace").read().decode(errors="replace")
    except Exception:
        return None
    fields = dict(line.split("=", 1) for line in body.splitlines() if "=" in line)
    return fields if fields.get("warp") in ("on", "plus") else None


class WarpExit:
    """Uscita di riserva da Cloudflare WARP, per quando YouTube ferma l'IP del worker.

    `usque` (client WARP open-source, tutto in spazio utente: gira anche senza privilegi di rete, dove
    il client ufficiale non si collega) registra un dispositivo gratuito e apre un SOCKS5 solo locale.
    Parte in un thread, così l'avvio del worker non lo aspetta; chi serve una richiesta lo aspetta con
    `proxy(wait=…)`. Il client gira senza le variabili d'ambiente del worker e, potendo, come utente
    «nobody»: non vede né la chiave del worker né i cookie.
    """

    def __init__(self) -> None:
        self.state = "off"  # off | starting | ready | failed
        self.error: str | None = None
        self.colo: str | None = None  # sede Cloudflare da cui esce il tunnel (sigla pubblica, es. «ORD»)
        self.renewals = 0  # quante volte è stato cambiato l'indirizzo di uscita
        self._process: subprocess.Popen | None = None
        self._config = WARP_DIR / "config.json"
        self._lock = threading.Lock()
        self._settled = threading.Event()  # alzato quando un avvio è finito, bene o male
        self._stopped = False
        self._failures = 0
        self._retry_at = 0.0

    def start(self) -> None:
        """Avvia (o riavvia) il tunnel in background. Senza effetto se è spento, se c'è YTDLP_PROXY
        (l'uscita scelta dall'owner), se un avvio è già in corso o se è presto per riprovare."""
        if not WARP_ENABLED or PROXY or self._stopped:
            return
        with self._lock:
            if self.state in ("starting", "ready") or time.monotonic() < self._retry_at:
                return
            self.state = "starting"
            self._settled.clear()
        threading.Thread(target=self._bootstrap, name="warp", daemon=True).start()

    def proxy(self, wait: float = 0.0) -> str | None:
        """L'URL del SOCKS locale se il tunnel porta traffico, altrimenti None. Con `wait` aspetta un
        avvio in corso (il worker appena svegliato riceve la richiesta prima che il tunnel sia su)."""
        if self.state == "ready" and (self._process is None or self._process.poll() is not None):
            self._fail("il client WARP si è fermato")
        if self.state == "failed":
            self.start()
        if self.state == "starting" and wait > 0:
            self._settled.wait(wait)
        return f"socks5://127.0.0.1:{WARP_PORT}" if self.state == "ready" else None

    def renew(self, wait: float) -> str | None:
        """Cambia indirizzo di uscita: riavvia il client con la stessa registrazione e aspetta che il
        tunnel porti di nuovo traffico. Misurato: l'indirizzo resta lo stesso finché il client vive e
        cambia a ogni riavvio, quindi è così che si lascia un indirizzo che YouTube ha fermato.
        Ritorna il proxy, o None se il tunnel non è tornato entro `wait` secondi."""
        with self._lock:
            if self._stopped or self.state not in ("ready", "starting"):
                return None
            restart = self.state == "ready"  # se un'altra richiesta lo sta già riavviando, si aspetta quello
            if restart:
                self.state = "starting"
                self._settled.clear()
        if restart:
            self.renewals += 1
            threading.Thread(target=self._bootstrap, name="warp", daemon=True).start()
        return self.proxy(wait=wait)

    def report_failure(self) -> None:
        """yt-dlp non è riuscito a passare dal SOCKS: il tunnel è da considerare giù e da riavviare."""
        if self.state == "ready":
            self._fail("il tunnel ha smesso di rispondere")

    def stop(self) -> None:
        """Spegne il tunnel e non lo riavvia più (chiusura del worker)."""
        self._stopped = True
        self._halt()
        self.state = "off"

    def _bootstrap(self) -> None:
        try:
            self._connect()
        except _WarpError as exc:
            self._fail(str(exc))
        except Exception as exc:  # qualunque cosa succeda, il worker continua a servire dall'uscita diretta
            self._fail(f"errore inatteso: {type(exc).__name__}")
        else:
            self._failures = 0
            self.state, self.error = "ready", None
            log.info("WARP: uscita pronta (sede %s)", self.colo or "?")
        finally:
            if self._stopped:  # spento mentre partiva: non deve restare un client in esecuzione
                self._halt()
                self.state = "off"
            self._settled.set()

    def _fail(self, reason: str) -> None:
        self._halt()
        if self._stopped:
            return
        delay = _WARP_RETRY_SECONDS[min(self._failures, len(_WARP_RETRY_SECONDS) - 1)]
        self._failures += 1
        self._retry_at = time.monotonic() + delay
        self.state, self.error = "failed", reason
        log.warning("WARP: uscita non disponibile (%s); nuovo tentativo fra %ss", reason, delay)
        # Si riprova da soli solo poche volte: dopo, soltanto quando arriva una richiesta (vedi proxy).
        if self._failures < len(_WARP_RETRY_SECONDS):
            timer = threading.Timer(delay + 0.5, self.start)
            timer.daemon = True
            timer.start()

    def _connect(self) -> None:
        if not shutil.which(WARP_BIN):
            raise _WarpError("il client WARP non è nell'immagine del worker")
        WARP_DIR.mkdir(parents=True, exist_ok=True)
        WARP_DIR.chmod(0o700)
        sandbox = self._sandbox()
        if not self._config.is_file():
            self._register(sandbox)
        self._halt()
        if self._stopped:
            raise _WarpError("spenta")
        with (WARP_DIR / "client.log").open("wb") as output:
            self._process = subprocess.Popen(
                [WARP_BIN, "-c", str(self._config), *_warp_command()],
                stdout=output,
                stderr=subprocess.STDOUT,
                **sandbox,
            )
        if not self._carries_traffic():
            raise _WarpError("il tunnel non risponde: serve traffico UDP in uscita verso Cloudflare")

    def _sandbox(self) -> dict:
        """Come viene eseguito il client: ambiente vuoto (le chiavi del worker non gli arrivano) e, se
        il worker è root e il sistema lo permette, utente «nobody» proprietario della sola WARP_DIR."""
        options: dict = {
            "cwd": str(WARP_DIR),
            "env": {"HOME": str(WARP_DIR), "PATH": "/usr/local/bin:/usr/bin:/bin"},
            "stdin": subprocess.DEVNULL,
        }
        if os.geteuid() != 0:
            return options
        try:
            nobody = pwd.getpwnam("nobody")
            identity = {"user": nobody.pw_uid, "group": nobody.pw_gid, "extra_groups": []}
            os.chown(WARP_DIR, nobody.pw_uid, nobody.pw_gid)
            subprocess.run([WARP_BIN, "version"], capture_output=True, timeout=15, check=False, **options, **identity)
        except (KeyError, OSError, subprocess.SubprocessError):
            # Niente cambio utente in questo container: resta l'ambiente vuoto.
            try:
                os.chown(WARP_DIR, os.geteuid(), os.getegid())
            except OSError:
                pass
            return options
        if self._config.is_file():
            os.chown(self._config, nobody.pw_uid, nobody.pw_gid)
        return {**options, **identity}

    def _register(self, sandbox: dict) -> None:
        """Registra un dispositivo WARP gratuito (una volta per container: la configurazione resta in
        WARP_DIR). `-a` accetta i termini di Cloudflare: per questo l'uscita va accesa esplicitamente."""
        command = [WARP_BIN, "-c", str(self._config), "register", "-a", "-n", "solco-worker"]
        try:
            done = subprocess.run(
                command, capture_output=True, encoding="utf-8", errors="replace", timeout=45, check=False, **sandbox
            )
        except subprocess.TimeoutExpired:
            raise _WarpError("registrazione: Cloudflare non ha risposto in tempo") from None
        if done.returncode == 0 and self._config.is_file():
            return
        output = " ".join(f"{done.stdout} {done.stderr}".split())
        log.warning("WARP: registrazione fallita: %s", _TOKEN.sub("[…]", output)[-300:])
        lowered = output.lower()
        if "429" in lowered or "too many" in lowered:
            raise _WarpError("registrazione: Cloudflare limita questo IP (429), si riprova più tardi")
        if any(marker in lowered for marker in ("dial tcp", "no such host", "timeout", "unreachable", "refused")):
            raise _WarpError("registrazione: il worker non raggiunge Cloudflare")
        raise _WarpError("registrazione rifiutata da Cloudflare")

    def _carries_traffic(self) -> bool:
        proxy = f"socks5://127.0.0.1:{WARP_PORT}"
        deadline = time.monotonic() + WARP_READY_SECONDS
        while time.monotonic() < deadline:
            if self._process is None or self._process.poll() is not None:
                return False
            trace = _warp_trace(proxy) if _port_open(WARP_PORT) else None
            if trace:
                self.colo = trace.get("colo")
                return True
            time.sleep(1)
        return False

    def _halt(self) -> None:
        process, self._process = self._process, None
        if process is None or process.poll() is not None:
            return
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()


WARP = WarpExit()


# Come yt-dlp racconta un proxy che rifiuta o non risponde (testi reali: 407 sul tunnel, porta chiusa,
# SOCKS che nega la connessione). Un proxy SOCKS irraggiungibile non nomina il proxy: vedi sotto.
_PROXY_FAILURES = ("proxyerror", "unable to connect to proxy", "tunnel connection failed")


def _proxy_reachable() -> bool:
    """Il proxy accetta connessioni? Controllo TCP breve PRIMA di yt-dlp: con host o porta sbagliati
    yt-dlp resterebbe appeso fino al timeout (e il bot di Solco con lui) senza dire perché."""
    parsed = urlsplit(PROXY)
    try:
        with socket.create_connection((parsed.hostname, parsed.port), timeout=PROXY_CONNECT_TIMEOUT):
            return True
    except OSError:
        return False


# Rifiuti che dipendono dal CLIENT YouTube e non dall'IP: un altro client può dare il file. Testi reali,
# misurati su un'uscita pulita: 403 sul media con il client predefinito, «The page needs to be reloaded»
# con tv, nessun file unico audio+video con visionos e web_safari.
_CLIENT_FAILURES = (
    "http error 403",
    "page needs to be reloaded",
    "requested format is not available",
    "no video formats found",
)
# Gli esiti dopo i quali ha senso un altro tentativo; tutti gli altri (video rimosso, 429, login…) no.
_RETRYABLE = {"youtube_bot_check", "media_unavailable"}


def _classify_error(exc: BaseException) -> str:
    """Riduce l'errore di yt-dlp a un codice stabile. L'ordine conta: il controllo anti-bot contiene
    anche "Sign in", quindi va riconosciuto PRIMA del login generico."""
    text = str(exc).replace("’", "'").lower()
    if "not a bot" in text:
        return "youtube_bot_check"
    # Prima del 429: anche il proxy può rispondere "Too Many Requests" sul tunnel, ed è un suo rifiuto.
    if any(marker in text for marker in _PROXY_FAILURES) or (
        "sockshttp" in text and "failed to establish a new connection" in text
    ):
        return "proxy_error"
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
    if any(marker in text for marker in _CLIENT_FAILURES):
        return "media_unavailable"
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


def _first_exit(deadline: float) -> tuple[str, str | None]:
    """Da dove esce il primo tentativo: (nome, proxy). Con YTDLP_PROXY da lì, perché è la scelta
    esplicita dell'owner. Con WARP acceso da WARP — lo si accende proprio perché l'IP del worker è
    fermato — aspettando il tunnel se sta ancora partendo; la diretta solo se WARP non c'è."""
    if PROXY:
        return "proxy", PROXY
    if WARP_ENABLED:
        tunnel = WARP.proxy(wait=max(0.0, min(WARP_WAIT_SECONDS, deadline - time.monotonic())))
        if tunnel:
            return "warp", tunnel
    return "direct", None


def _wait_for_warp(deadline: float) -> str | None:
    """Il tunnel WARP sta ripartendo (cambio d'indirizzo lento, o caduto e riavviato da solo dopo qualche
    secondo): lo si aspetta finché resta budget per un tentativo. Ritorna il proxy, o None."""
    while True:
        left = deadline - time.monotonic() - WARP_MIN_ATTEMPT_SECONDS
        if left <= 0:
            return None
        proxy = WARP.proxy(wait=min(WARP_WAIT_SECONDS, left))
        if proxy:
            return proxy
        if WARP.state not in ("starting", "failed"):
            return None
        # «failed» si riavvia da solo dopo una breve pausa: si ricontrolla fra poco.
        time.sleep(min(1.0, max(0.0, deadline - time.monotonic())))


def _note_outcome(status: str, tried: list[str], started: float | None = None) -> None:
    """Registra l'esito per /health: l'ultimo tentativo («tv», oppure «warp/tv» uscendo da WARP),
    quanti ne sono serviti e quanto è durato tutto — il bot di Solco aspetta 40 secondi."""
    exit_name, _, client = (tried[-1] if tried else "").rpartition("/")
    if tried:
        exit_name = exit_name or ("proxy" if PROXY else "direct")
    _LAST_OUTCOME.update(
        status=status,
        client=client or None,
        exit=exit_name or None,
        attempts=len(tried),
        seconds=round(time.monotonic() - started, 1) if started is not None else None,
        at=int(time.time()),
    )


def _run_with_antibot(
    opts: dict,
    work: Callable[[Any], Any],
    cleanup: Callable[[], None] | None = None,
) -> tuple[Any, list[str]]:
    """Esegue `work(ydl)` finché un tentativo riesce, cambiando ciò che YouTube ha rifiutato.

    Ritorna (risultato, tentativi — l'ultimo è quello riuscito; «warp/tv» = client tv uscendo da WARP).
    Solleva UpstreamFailure con il codice dell'ultimo errore. Si riprova solo dopo il controllo anti-bot
    o un rifiuto legato al client (_RETRYABLE): video rimosso, 429 o login non si risolvono così e
    fermano subito i tentativi.

    Che cosa si cambia dipende da che cosa è stato rifiutato (tutto misurato, vedi README):
    - il controllo anti-bot riguarda l'INDIRIZZO: uscendo da WARP si cambia indirizzo (WARP.renew) e si
      ripete lo stesso client, fino a WARP_RENEWALS volte; poi, come senza WARP, si provano gli altri
      client, che è un tentativo a costo zero ma di rado basta;
    - gli altri rifiuti riguardano il CLIENT: si passa al successivo dalla stessa uscita;
    - se il cambio d'indirizzo è lento, o il tunnel cade, lo si aspetta finché c'è budget (una sola
      ripartenza per richiesta): l'IP del worker è fermato da YouTube, quindi la diretta è l'ultima
      risorsa, solo quando WARP non torna.
    """
    global _PREFERRED_CLIENT
    if PROXY and not _proxy_reachable():
        log.warning("proxy non raggiungibile entro %.0fs: yt-dlp non viene avviato", PROXY_CONNECT_TIMEOUT)
        _note_outcome("proxy_unreachable", [])
        raise UpstreamFailure("proxy_unreachable", [])
    started = time.monotonic()
    deadline = started + ANTIBOT_BUDGET_SECONDS
    tried: list[str] = []
    kind = "failed"
    exit_name, proxy = _first_exit(deadline)
    # Che ne è stato dell'uscita WARP, per dirlo all'owner: non disponibile («down») o fermata anche
    # lei dal controllo anti-bot («blocked»).
    warp = "down" if WARP_ENABLED and not PROXY and exit_name != "warp" else None
    renewals = 0
    restarts = 0
    plan = _client_plan()
    position = 0

    def give_up() -> UpstreamFailure:
        _note_outcome(kind, tried, started)
        return UpstreamFailure(kind, tried, warp)

    while position < len(plan):
        label, clients = plan[position]
        if tried and time.monotonic() >= deadline:
            log.warning("anti-bot: budget di %.0fs esaurito dopo %s", ANTIBOT_BUDGET_SECONDS, tried)
            break
        attempt = dict(opts)
        if proxy:
            attempt["proxy"] = proxy
        if clients:
            attempt["extractor_args"] = {"youtube": {"player_client": clients}}
        name = f"warp/{label}" if exit_name == "warp" else label
        tried.append(name)
        try:
            with yt_dlp.YoutubeDL(attempt) as ydl:
                result = work(ydl)
        except Exception as exc:  # yt-dlp mette il motivo nel testo di DownloadError/ExtractorError
            failure = _classify_error(exc)
            log.warning("yt-dlp fallito (tentativo=%s, esito=%s): %s", name, failure, _redact(str(exc))[:300])
            if cleanup:
                cleanup()
            if exit_name == "warp" and failure == "proxy_error":
                # Il tunnel è caduto: non è una risposta di YouTube. Lo si riavvia e, se torna entro il
                # budget, si riparte da WARP; la diretta (fermata da YouTube) solo se il tunnel non torna.
                WARP.report_failure()
                proxy = None
                if restarts < 1:  # una sola ripartenza per richiesta: un tunnel instabile non è un'uscita
                    restarts += 1
                    proxy = _wait_for_warp(deadline)
                if proxy:
                    position = 0
                    continue
                warp, exit_name, proxy, position = "down", "direct", None, 0
                continue
            kind = failure
            if kind not in _RETRYABLE:
                break
            if label == _PREFERRED_CLIENT:
                _PREFERRED_CLIENT = None  # non passa più: si riparte dalla configurazione
            if kind == "youtube_bot_check" and exit_name == "warp":
                warp = "blocked"
                if renewals < WARP_RENEWALS:
                    renewals += 1
                    proxy = WARP.renew(wait=max(1.0, min(WARP_WAIT_SECONDS, deadline - time.monotonic())))
                    if not proxy:
                        # Riavvio lento o fallito: si aspetta il tunnel ancora, nel budget, invece di
                        # spendere i tentativi sull'IP del worker, che YouTube ferma sempre (misurato).
                        proxy = _wait_for_warp(deadline)
                    if proxy:
                        log.info("anti-bot: indirizzo di uscita cambiato (%s di %s), riprovo %s", renewals, WARP_RENEWALS, name)
                        continue  # stesso client, indirizzo nuovo
                    # Il tunnel non è tornato in tempo: resta la diretta.
                    warp, exit_name, position = "down", "direct", 0
                    continue
            position += 1
            continue
        if len(tried) > 1 and clients and len(clients) == 1:
            _PREFERRED_CLIENT = clients[0]
            log.info("anti-bot: superato con %s (dopo %s)", name, tried[:-1])
        _note_outcome("ok", tried, started)
        return result, tried
    raise give_up()


def _upstream_http(failure: UpstreamFailure, generic: str) -> HTTPException:
    """502 con `detail` = codice riconosciuto (es. youtube_bot_check) o il messaggio generico di prima.
    Al controllo anti-bot si accodano le leve già attive (`youtube_bot_check+cookies+proxy`,
    `youtube_bot_check+warp`): così Solco non consiglia di impostare ciò che c'è già."""
    if failure.kind == "failed":
        return HTTPException(status_code=502, detail=generic)
    levers = _active_levers(failure.warp) if failure.kind == "youtube_bot_check" else []
    return HTTPException(status_code=502, detail="+".join([failure.kind, *levers]))


def _check_auth(authorization: str | None) -> None:
    # FAIL-CLOSED: senza WORKER_API_KEY il worker RIFIUTA tutto (503), a meno di WORKER_ALLOW_OPEN=1
    # (solo per test locali). Così non resta mai pubblico per sbaglio.
    if not API_KEY:
        if ALLOW_OPEN:
            return
        raise HTTPException(status_code=503, detail="worker not configured: set WORKER_API_KEY")
    given = authorization or ""
    # Confronto a tempo costante con ENTRAMBE le chiavi (niente scorciatoie che rivelino quale).
    ok = [hmac.compare_digest(given, f"Bearer {key}") for key in (API_KEY, API_KEY_2) if key]
    if not given or not any(ok):
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
        "avvio worker: mode=%s auth=%s cookies=%s proxy=%s warp=%s player_client=%s fallback=%s max=%sMB",
        MODE,
        auth_state,
        "si" if COOKIEFILE else "no",
        urlsplit(PROXY).scheme if PROXY else "no",
        "si" if WARP_ENABLED and not PROXY else "no",
        PLAYER_CLIENT or "default",
        ",".join(FALLBACK_CLIENTS) or "nessuno",
        MAX_FILESIZE_MB,
    )
    if WARP_ENABLED and PROXY:
        log.warning("YTDLP_WARP %s", WARP_IGNORED)
    WARP.start()
    if PROXY_ERROR:
        log.warning("YTDLP_PROXY ignorato: %s", PROXY_ERROR)
    if PROXY_IGNORED:
        log.warning("YTDLP_PROXY contiene un elenco: uso il primo proxy leggibile, ignoro gli altri %s", PROXY_IGNORED)
    if not API_KEY and not ALLOW_OPEN:
        log.warning("WORKER_API_KEY non impostata: ogni richiesta risponderà 503 finché non la imposti.")
    task = asyncio.create_task(_cleanup_loop()) if MODE == "serve" else None
    yield
    if task:
        task.cancel()
    WARP.stop()


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
        # /chat → server DeepSeek: solo se è configurato (mai l'URL né il token).
        "chat": bool(CHAT_ENDPOINT_URL),
        # Stato anti-bot (nessun segreto): le leve attive e l'esito dell'ULTIMA richiesta a monte.
        "antibot": {
            "fallback_clients": FALLBACK_CLIENTS,
            "preferred_client": _PREFERRED_CLIENT,
            "proxy": bool(PROXY),
            # Schema del proxy accettato, o perché YTDLP_PROXY è stato scartato; `ignored` conta le altre
            # voci di un elenco (se ne usa una sola). Mai host o credenziali.
            "proxy_info": {
                "scheme": urlsplit(PROXY).scheme if PROXY else None,
                "error": PROXY_ERROR,
                "ignored": PROXY_IGNORED,
            },
            # Uscita da Cloudflare WARP: se è accesa (YTDLP_WARP=1), a che punto è
            # (off | starting | ready | failed), da quale sede Cloudflare esce, quante volte ha
            # cambiato indirizzo perché YouTube lo aveva fermato e, se non va, perché.
            "warp": {
                "enabled": WARP_ENABLED,
                "state": WARP.state,
                "colo": WARP.colo if WARP.state == "ready" else None,
                "renewals": WARP.renewals,
                "error": WARP_IGNORED if WARP_ENABLED and PROXY else WARP.error,
            },
            "last": dict(_LAST_OUTCOME),
        },
    }


@app.get("/antibot")
def antibot(authorization: str | None = Header(default=None)) -> dict:
    """Sonda anti-bot: ESTRAE (senza scaricare) un video pubblico di YouTube e dice se questo worker
    supera il controllo. Richiede la chiave come /download, perché genera traffico in uscita."""
    _check_auth(authorization)
    started = time.monotonic()
    warp = None
    try:
        # process=False: basta la risposta del player (dove scatta il controllo), niente scelta formati.
        _, tried = _run_with_antibot(
            _base_opts(),
            lambda ydl: ydl.extract_info(PROBE_URL, download=False, process=False),
        )
        status = "ok"
    except UpstreamFailure as failure:
        status, tried, warp = failure.kind, failure.tried, failure.warp
    passed = tried[-1] if status == "ok" and tried else None
    via_warp = bool(passed and passed.startswith("warp/"))
    return {
        "youtube": status,
        "client": passed.rpartition("/")[2] if passed else None,
        # Da dove è uscito il tentativo riuscito: «warp», «proxy» o «direct».
        "exit": ("warp" if via_warp else "proxy" if PROXY else "direct") if passed else None,
        "tried": tried,
        "cookies": bool(COOKIEFILE),
        "proxy": bool(PROXY),
        "warp": WARP.state,
        "seconds": round(time.monotonic() - started, 1),
        "hint": (
            "YouTube risponde uscendo da Cloudflare WARP (l'IP del worker, da solo, è fermato)."
            if via_warp
            else _hint(status, warp)
        ),
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


_DOWNLOAD_SLOTS = threading.BoundedSemaphore(MAX_CONCURRENT_DOWNLOADS)


@app.post("/download")
def download(
    req: DownloadRequest,
    request: Request,
    authorization: str | None = Header(default=None),
) -> dict:
    _check_auth(authorization)
    target = _target(req)
    # Non si accoda: con tutti i posti occupati si risponde subito, così il bot lo dice all'utente
    # invece di aspettare a vuoto i suoi 40 s.
    if not _DOWNLOAD_SLOTS.acquire(blocking=False):
        log.warning("download rifiutato: %s già in corso", MAX_CONCURRENT_DOWNLOADS)
        raise HTTPException(status_code=503, detail="busy", headers={"Retry-After": "30"})
    try:
        log.info("richiesta download: mode=%s target=%s", MODE, target[:200])
        result = (
            _serve_download(target, request, req.format)
            if MODE == "serve"
            else _extract_url(target, req.format)
        )
    finally:
        _DOWNLOAD_SLOTS.release()
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
    limit = MAX_FILESIZE_MB * 1024 * 1024
    # Spazio prima di iniziare: scoprirlo a scrittura in corso lascerebbe un parziale e un errore opaco.
    try:
        free = shutil.disk_usage(DOWNLOAD_DIR).free
    except OSError:
        free = None
    if free is not None and free < limit:
        log.warning("download rifiutato: %s MB liberi, servono %s MB", free // (1024 * 1024), MAX_FILESIZE_MB)
        raise HTTPException(status_code=507, detail="insufficient storage")
    token = uuid.uuid4().hex
    ydl_opts = {
        **_base_opts(),
        "format": fmt or FORMAT,
        "outtmpl": str(DOWNLOAD_DIR / f"{token}.%(ext)s"),
        "max_filesize": limit,
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

    # max_filesize vale sulla dimensione DICHIARATA: un download a frammenti (HLS/DASH) senza dimensione
    # nota arriva intero, quindi si controlla anche quella vera. In entrambi i casi niente resta su disco.
    if not path.is_file() or path.stat().st_size > limit:
        cleanup()
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


# ── /chat: proxy verso il TUO server DeepSeek (OpenAI-compatibile: vLLM, SGLang, ...) ────────────────
# Stessa auth fail-closed di /download (Bearer WORKER_API_KEY): il modello non è mai pubblico.
#   DEEPSEEK_ENDPOINT_URL    base URL del server, es. https://gpu.example.com/v1   (senza: /chat → 503)
#   DEEPSEEK_ENDPOINT_TOKEN  bearer del server, se lo richiede                     (secret)
#   DEEPSEEK_MODEL_ID        nome del modello registrato sul server
#   DEEPSEEK_TIMEOUT         secondi di attesa della risposta (default 120)
CHAT_ENDPOINT_URL = os.environ.get("DEEPSEEK_ENDPOINT_URL", "").strip().rstrip("/")
CHAT_ENDPOINT_TOKEN = os.environ.get("DEEPSEEK_ENDPOINT_TOKEN", "").strip()
CHAT_MODEL_ID = (
    os.environ.get("DEEPSEEK_MODEL_ID", "").strip() or "OBLITERATUS/DeepSeek-V4.1-Flash-1017-obliterated"
)
CHAT_TIMEOUT = max(5.0, float(os.environ.get("DEEPSEEK_TIMEOUT", "120")))
_CHAT_SLOTS = threading.BoundedSemaphore(max(1, int(os.environ.get("MAX_CONCURRENT_CHATS", "4"))))


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    temperature: float | None = None
    top_p: float | None = None
    max_tokens: int | None = None


def _chat_payload(req: ChatRequest) -> dict:
    if not req.messages or len(req.messages) > 100:
        raise HTTPException(status_code=400, detail="messages: 1-100 required")
    if any(m.role not in ("system", "user", "assistant") for m in req.messages):
        raise HTTPException(status_code=400, detail="messages: role must be system|user|assistant")
    if sum(len(m.content) for m in req.messages) > 200_000:
        raise HTTPException(status_code=413, detail="messages too long")
    payload: dict[str, Any] = {
        "model": CHAT_MODEL_ID,
        "messages": [m.model_dump() for m in req.messages],
        "stream": False,
    }
    if req.temperature is not None:
        payload["temperature"] = min(2.0, max(0.0, req.temperature))
    if req.top_p is not None:
        payload["top_p"] = min(1.0, max(0.01, req.top_p))
    if req.max_tokens is not None:
        payload["max_tokens"] = min(8192, max(1, req.max_tokens))
    return payload


@app.post("/chat")
def chat(req: ChatRequest, authorization: str | None = Header(default=None)) -> dict:
    """Una risposta completa (non in streaming) dal server DeepSeek: {"reply", "model", "usage"}."""
    _check_auth(authorization)
    if not CHAT_ENDPOINT_URL:
        raise HTTPException(status_code=503, detail="chat not configured: set DEEPSEEK_ENDPOINT_URL")
    payload = _chat_payload(req)
    if not _CHAT_SLOTS.acquire(blocking=False):
        raise HTTPException(status_code=503, detail="busy", headers={"Retry-After": "10"})
    try:
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if CHAT_ENDPOINT_TOKEN:
            headers["Authorization"] = f"Bearer {CHAT_ENDPOINT_TOKEN}"
        upstream = urllib.request.Request(
            f"{CHAT_ENDPOINT_URL}/chat/completions",
            data=json.dumps(payload).encode(),
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(upstream, timeout=CHAT_TIMEOUT) as resp:
                data = json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            log.warning("chat: il server DeepSeek ha risposto %s", exc.code)
            raise HTTPException(status_code=502, detail=f"upstream_http_{exc.code}") from None
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            log.warning("chat: server DeepSeek irraggiungibile: %s", type(exc).__name__)
            raise HTTPException(status_code=504, detail="upstream_unreachable") from None
        except ValueError:
            raise HTTPException(status_code=502, detail="upstream_bad_json") from None
        try:
            reply = data["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError, TypeError):
            raise HTTPException(status_code=502, detail="upstream_bad_shape") from None
        return {"reply": reply, "model": data.get("model", CHAT_MODEL_ID), "usage": data.get("usage")}
    finally:
        _CHAT_SLOTS.release()

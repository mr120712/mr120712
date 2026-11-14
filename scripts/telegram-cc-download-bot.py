#!/usr/bin/env python3
"""
telegram-cc-download-bot.py — bot Telegram LOCALE per scaricare audio Creative Commons.

Gira sul TUO PC in long-polling (getUpdates): nessun webhook, nessun server pubblico, niente di
collegato al sito Solco. Mandi uno o più link YouTube al bot (anche uno per riga, o un file .txt di
URL) e, SE il video ha licenza **Creative Commons** (o è un tuo contenuto, con /own), lo scarica in
locale in MP3 e te lo rimanda su Telegram. Stessa regola di scripts/yt-dlp-cc-download.py: i video
NON Creative Commons vengono SALTATI; non è uno strumento per rippare musica di terzi protetta.

Accetta solo URL di domini in whitelist (default youtube.com/youtu.be; override con
TELEGRAM_DL_ALLOWED_DOMAINS, separati da virgola). Un file .txt inviato in chat è letto come
--urls-file (un URL per riga, '#' = commento), con un tetto di MAX_BATCH link per messaggio.

Serve un bot DEDICATO (diverso da quello del sito: getUpdates e webhook non convivono sullo stesso
token):
  1) crea un bot con @BotFather e copia il token;
  2) imposta le variabili d'ambiente:
       export TELEGRAM_DL_BOT_TOKEN="123456:ABC..."
       export TELEGRAM_DL_ALLOWED_IDS="11111111"      # il/i TUOI chat id (virgola per più d'uno)
       export TELEGRAM_DL_OUT="download"              # cartella locale (facoltativa)
  3) avvia:  python3 scripts/telegram-cc-download-bot.py

Non conosci il tuo chat id? Avvia il bot senza TELEGRAM_DL_ALLOWED_IDS, scrivigli: ti risponde con
il tuo id (ma NON scarica finché non ti autorizzi mettendolo nella variabile e riavviando).

Requisiti: yt-dlp e ffmpeg installati.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://api.telegram.org/bot{token}/{method}"
# Identico allo script locale: tiene SOLO i contenuti con licenza Creative Commons.
CC_MATCH_FILTER = "license ~= (?i)creative commons"
MAX_UPLOAD = 49 * 1024 * 1024  # limite pratico per l'invio file da bot (~50MB)

TOKEN = os.environ.get("TELEGRAM_DL_BOT_TOKEN", "").strip()
ALLOWED = {s.strip() for s in os.environ.get("TELEGRAM_DL_ALLOWED_IDS", "").split(",") if s.strip()}
OUT_DIR = Path(os.environ.get("TELEGRAM_DL_OUT", "download")).resolve()

# Domini consentiti (override con TELEGRAM_DL_ALLOWED_DOMAINS, separati da virgola). Gli URL verso
# altri host vengono rifiutati; il filtro CC resta comunque il controllo principale sui diritti.
_DEFAULT_DOMAINS = "youtube.com,youtu.be,m.youtube.com,music.youtube.com,www.youtube.com"
ALLOWED_DOMAINS = {
    d.strip().lower()
    for d in os.environ.get("TELEGRAM_DL_ALLOWED_DOMAINS", _DEFAULT_DOMAINS).split(",")
    if d.strip()
}
# Numero massimo di URL elaborati per messaggio/file (anti-flood locale).
MAX_BATCH = 30


def api(method: str, params: dict | None = None, timeout: int = 70) -> dict:
    url = API.format(token=TOKEN, method=method)
    data = urllib.parse.urlencode(params or {}).encode() if params else None
    request = urllib.request.Request(url, data=data)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def send(chat_id: int | str, text: str) -> None:
    try:
        api("sendMessage", {"chat_id": chat_id, "text": text, "disable_web_page_preview": "true"})
    except Exception as error:  # noqa: BLE001 — un bot non deve morire per un invio fallito
        print("sendMessage fallito:", error)


def send_audio(chat_id: int | str, path: Path) -> None:
    """Invia un file come audio (multipart con la sola stdlib)."""
    safe_name = path.name.replace('"', "").replace("\r", " ").replace("\n", " ")
    boundary = "----solcocc" + os.urandom(8).hex()
    body = bytearray()
    body.extend(
        f'--{boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n{chat_id}\r\n'.encode()
    )
    body.extend(
        f'--{boundary}\r\nContent-Disposition: form-data; name="audio"; filename="{safe_name}"\r\n'.encode()
    )
    body.extend(b"Content-Type: application/octet-stream\r\n\r\n")
    body.extend(path.read_bytes())
    body.extend(f"\r\n--{boundary}--\r\n".encode())
    request = urllib.request.Request(API.format(token=TOKEN, method="sendAudio"), data=bytes(body))
    request.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    with urllib.request.urlopen(request, timeout=600) as response:
        json.load(response)


def download(url: str, own: bool) -> list[Path]:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    before = set(OUT_DIR.glob("*.mp3"))
    cmd = [
        "yt-dlp",
        "-f",
        "bestaudio/best",
        "-o",
        str(OUT_DIR / "%(uploader)s - %(title)s [%(id)s].%(ext)s"),
        "--no-overwrites",
        "--ignore-errors",
        "--extract-audio",
        "--audio-format",
        "mp3",
        "--audio-quality",
        "0",
        "--embed-metadata",
        "--embed-thumbnail",
    ]
    if not own:
        # Senza /own scarica SOLO i Creative Commons (lo impone yt-dlp a monte).
        cmd += ["--match-filter", CC_MATCH_FILTER]
    cmd.append(url)
    subprocess.run(cmd, check=False)
    after = set(OUT_DIR.glob("*.mp3"))
    return sorted(after - before, key=lambda p: p.stat().st_mtime)


def host_allowed(url: str) -> bool:
    host = (urllib.parse.urlparse(url).hostname or "").lower()
    return bool(host) and any(host == dom or host.endswith("." + dom) for dom in ALLOWED_DOMAINS)


def extract_urls(text: str) -> list[str]:
    """Tutti gli URL http(s) nel testo (uno o più, anche uno per riga)."""
    return [tok for tok in text.split() if tok.startswith(("http://", "https://"))]


def read_document_urls(document: dict) -> list[str] | None:
    """Scarica un documento .txt inviato al bot e ne legge gli URL (uno per riga, '#' = commento).

    È l'equivalente di --urls-file dello script locale. Ritorna None se non riesce a leggerlo.
    """
    file_id = document.get("file_id")
    if not file_id:
        return None
    try:
        info = api("getFile", {"file_id": file_id})
        file_path = info.get("result", {}).get("file_path")
        if not file_path:
            return None
        url = f"https://api.telegram.org/file/bot{TOKEN}/{file_path}"
        with urllib.request.urlopen(url, timeout=60) as response:
            content = response.read().decode("utf-8", "replace")
    except Exception as error:  # noqa: BLE001
        print("getFile fallito:", error)
        return None
    return [
        line.strip()
        for line in content.splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]


def deliver(chat_id: int | str, path: Path) -> None:
    send(chat_id, f"✅ Scaricato in locale: {path.name}")
    if path.stat().st_size <= MAX_UPLOAD:
        try:
            send_audio(chat_id, path)
        except Exception as error:  # noqa: BLE001
            send(chat_id, f"(invio su Telegram non riuscito: {error} — il file è nella cartella locale)")
    else:
        send(chat_id, "(oltre ~50MB: non lo invio su Telegram, è nella cartella locale)")


def process_urls(chat_id: int | str, urls: list[str], own: bool) -> None:
    allowed = [u for u in urls if host_allowed(u)]
    for bad in (u for u in urls if u not in allowed):
        host = urllib.parse.urlparse(bad).hostname or bad
        send(chat_id, f"⛔ Dominio non consentito, salto: {host}")
    if not allowed:
        return
    if len(allowed) > MAX_BATCH:
        send(chat_id, f"Troppi link ({len(allowed)}): elaboro i primi {MAX_BATCH}.")
        allowed = allowed[:MAX_BATCH]
    for url in allowed:
        send(chat_id, f"⏳ Scarico: {url}")
        try:
            files = download(url, own)
        except Exception as error:  # noqa: BLE001
            send(chat_id, f"Errore durante il download: {error}")
            continue
        if not files:
            send(
                chat_id,
                "⏭️ Saltato: non ha licenza Creative Commons (usa /own se è un tuo contenuto)."
                if not own
                else "Nessun file scaricato (controlla il link).",
            )
            continue
        for path in files:
            deliver(chat_id, path)


def handle(update: dict) -> None:
    message = update.get("message") or update.get("channel_post")
    if not message:
        return
    chat_id = message.get("chat", {}).get("id")
    if chat_id is None:
        return

    # Autorizzazione esplicita: solo i chat id in TELEGRAM_DL_ALLOWED_IDS possono scaricare.
    if str(chat_id) not in ALLOWED:
        send(
            chat_id,
            f"Autorizzazione necessaria. Il tuo chat id è {chat_id}: aggiungilo a "
            "TELEGRAM_DL_ALLOWED_IDS e riavvia il bot.",
        )
        return

    # File .txt inviato al bot: equivalente di --urls-file (un URL per riga).
    document = message.get("document")
    if document:
        urls = read_document_urls(document)
        if urls is None:
            send(chat_id, "Non riesco a leggere il file.")
            return
        if not urls:
            send(chat_id, "Il file non contiene URL.")
            return
        process_urls(chat_id, urls, own=False)
        return

    text = (message.get("text") or "").strip()
    if text in ("/start", "/help", ""):
        send(
            chat_id,
            "Mandami uno o più link (anche uno per riga), oppure un file .txt di URL: scarico "
            "l'audio in MP3 SOLO se ha licenza Creative Commons.\n"
            "Usa «/own <link>» per un contenuto TUO (toglie il filtro CC; devi averne i diritti).\n"
            f"Domini consentiti: {', '.join(sorted(ALLOWED_DOMAINS))}.",
        )
        return

    own = text.startswith("/own")
    if own:
        text = text[len("/own") :].strip()
    urls = extract_urls(text)
    if not urls:
        send(chat_id, "Mandami uno o più URL http(s), o un file .txt. /help per le istruzioni.")
        return
    process_urls(chat_id, urls, own)


def main() -> int:
    if not TOKEN:
        sys.exit("Imposta TELEGRAM_DL_BOT_TOKEN (un bot DEDICATO creato con @BotFather).")
    for tool in ("yt-dlp", "ffmpeg"):
        if shutil.which(tool) is None:
            sys.exit(f"Manca «{tool}». Installalo prima di avviare il bot.")
    if not ALLOWED:
        print(
            "⚠️  TELEGRAM_DL_ALLOWED_IDS non impostato: il bot dirà a chi scrive il proprio chat id "
            "ma non scaricherà per nessuno finché non ti autorizzi."
        )
    print(f"Bot avviato. Output in {OUT_DIR}. Autorizzati: {ALLOWED or '(nessuno)'}. Ctrl+C per uscire.")

    offset: int | None = None
    while True:
        try:
            params: dict = {"timeout": 60}
            if offset is not None:
                params["offset"] = offset
            response = api("getUpdates", params, timeout=70)
        except KeyboardInterrupt:
            print("\nChiudo.")
            return 0
        except Exception as error:  # noqa: BLE001 — rete instabile: riprova
            print("getUpdates fallito, riprovo:", error)
            time.sleep(3)
            continue
        for update in response.get("result", []):
            offset = update["update_id"] + 1
            try:
                handle(update)
            except Exception as error:  # noqa: BLE001
                print("handle fallito:", error)


if __name__ == "__main__":
    raise SystemExit(main())

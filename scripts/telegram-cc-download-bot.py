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

Ricerca e pool di link:
  /cerca <parole>  cerca brani Creative Commons (yt-dlp ytsearch) e AGGIORNA il pool della chat
  /pool            mostra il pool corrente;  /pool clear  lo svuota
  /dl <n>          scarica il brano n del pool (effetti combinabili: /dl 2 /slow)
Il pool è in memoria, per chat (il bot è a processo singolo), e viene rimpiazzato a ogni /cerca.

Comandi effetto (il tono segue la velocità, stile "slowed / sped up", via ffmpeg):
  /slow <link>            rallentato (x0.85)
  /reverb <link>          rallentato + eco
  /fast <link>            accelerato / nightcore (x1.25)
  /speed <fattore> <link> velocità a scelta (0.5–2)
I comandi si combinano con /own, es. "/own /slow <link>", e valgono anche nella didascalia di
un file .txt. Richiede ffprobe (incluso in ffmpeg) per la frequenza di campionamento.

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

# Effetto "slowed / sped up": il tono segue la velocità (come la peculiarità del sito). Preset dei
# comandi e intervallo consentito per /speed <fattore>.
MIN_SPEED = 0.5
MAX_SPEED = 2.0
SLOWED_SPEED = 0.85
SLOWED_REVERB_SPEED = 0.82
SPEDUP_SPEED = 1.25

# Ricerca musica: quanti risultati cercare/mostrare (solo Creative Commons). I titoli vengono
# accorciati per non superare il limite di un messaggio Telegram.
SEARCH_COUNT = 12
TITLE_MAX = 80
# Pool di link PER CHAT, in memoria: /cerca lo aggiorna, /pool lo mostra, /dl <n> ci scarica. Il bot
# è a processo singolo (long-polling), quindi un semplice dict basta e non serve alcun lock.
POOLS: dict[str, list[str]] = {}


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
    send(chat_id, f"✅ Pronto in locale: {path.name}")
    if path.stat().st_size <= MAX_UPLOAD:
        try:
            send_audio(chat_id, path)
        except Exception as error:  # noqa: BLE001
            send(chat_id, f"(invio su Telegram non riuscito: {error} — il file è nella cartella locale)")
    else:
        send(chat_id, "(oltre ~50MB: non lo invio su Telegram, è nella cartella locale)")


def clamp_speed(value: float) -> float:
    return max(MIN_SPEED, min(MAX_SPEED, value))


def probe_sample_rate(path: Path) -> int | None:
    """Frequenza di campionamento del file (ffprobe); None se non disponibile."""
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "stream=sample_rate",
                "-of",
                "default=nokey=1:noprint_wrappers=1",
                str(path),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        value = result.stdout.strip().splitlines()[0] if result.stdout.strip() else ""
        return int(value) if value.isdigit() else None
    except Exception:  # noqa: BLE001
        return None


def speed_tag(speed: float, reverb: bool) -> str:
    if reverb and speed < 1:
        return "slowed+reverb"
    if reverb:
        return "reverb"
    return "slowed" if speed < 1 else "spedup"


def apply_speed(src: Path, speed: float, reverb: bool) -> Path:
    """Crea una versione slowed/sped-up con ffmpeg: il tono segue la velocità, come sul sito.

    asetrate reinterpreta la frequenza di campionamento → cambia tempo E tono (effetto "giradischi");
    aresample riporta a una frequenza standard per l'encoder. Con reverb aggiunge un'eco leggera.
    In caso di errore ritorna il file originale (invariato).
    """
    sample_rate = probe_sample_rate(src) or 44100
    new_rate = max(8000, int(sample_rate * clamp_speed(speed)))
    chain = [f"asetrate={new_rate}", f"aresample={sample_rate}"]
    if reverb:
        chain.append("aecho=0.8:0.85:60:0.35")
    out = src.with_name(f"{src.stem} [{speed_tag(speed, reverb)} {speed:g}x]{src.suffix}")
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(src), "-filter:a", ",".join(chain), "-b:a", "192k", str(out)],
        check=False,
    )
    return out if out.exists() else src


def transform_and_deliver(chat_id: int | str, path: Path, speed: float, reverb: bool) -> None:
    """Consegna il file; se è richiesto un effetto, prima crea la versione slowed/sped-up."""
    if abs(speed - 1.0) < 1e-6 and not reverb:
        deliver(chat_id, path)
        return
    send(chat_id, f"🎚️ Applico «{speed_tag(speed, reverb)}» (x{speed:g})…")
    out = apply_speed(path, speed, reverb)
    if out == path or not out.exists():
        send(chat_id, "Non sono riuscito a creare la versione modificata: invio l'originale.")
        deliver(chat_id, path)
        return
    deliver(chat_id, out)


def parse_command(text: str) -> tuple[bool, float, bool, str]:
    """Legge i comandi iniziali (/own, /slow, /fast, /reverb, /speed <n>) e ritorna il resto.

    Ritorna (own, speed, reverb, resto_del_testo). I comandi possono combinarsi, es. «/own /slow <url>».
    """
    own = False
    speed = 1.0
    reverb = False
    tokens = text.split()
    index = 0
    while index < len(tokens) and tokens[index].startswith("/"):
        cmd = tokens[index].split("@", 1)[0].lower()
        if cmd == "/own":
            own = True
            index += 1
        elif cmd in ("/slow", "/slowed", "/rallenta"):
            speed = SLOWED_SPEED
            index += 1
        elif cmd in ("/slowreverb", "/slowedreverb", "/reverb"):
            speed = SLOWED_REVERB_SPEED
            reverb = True
            index += 1
        elif cmd in ("/fast", "/speedup", "/nightcore", "/accelera"):
            speed = SPEDUP_SPEED
            index += 1
        elif cmd in ("/speed", "/velocita"):
            index += 1
            if index < len(tokens):
                try:
                    speed = clamp_speed(float(tokens[index].lower().replace("x", "").replace(",", ".")))
                    index += 1
                except ValueError:
                    pass
        else:
            break
    return own, speed, reverb, " ".join(tokens[index:])


def search_music(query: str, count: int = SEARCH_COUNT) -> list[tuple[str, str]]:
    """Cerca su YouTube e tiene SOLO i risultati con licenza Creative Commons (lo impone yt-dlp).

    Niente --flat-playlist: serve l'estrazione completa perché il campo `license` esista e il
    match-filter possa scartare i non-CC. Ritorna [(titolo, url)] dai soli domini in whitelist.
    """
    cmd = [
        "yt-dlp",
        f"ytsearch{count}:{query}",
        "--match-filter",
        CC_MATCH_FILTER,
        "--no-download",
        "--ignore-errors",
        "--no-warnings",
        "--print",
        "%(title)s\t%(webpage_url)s",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=180, check=False)
    except Exception as error:  # noqa: BLE001
        print("ricerca fallita:", error)
        return []
    results: list[tuple[str, str]] = []
    for line in result.stdout.splitlines():
        if "\t" not in line:
            continue
        title, url = line.split("\t", 1)
        url = url.strip()
        if url.startswith(("http://", "https://")) and host_allowed(url):
            results.append((title.strip(), url))
    return results


def handle_search(chat_id: int | str, query: str) -> None:
    if not query:
        send(chat_id, "Uso: /cerca <parole>. Es.: /cerca lofi creative commons")
        return
    send(chat_id, f"🔎 Cerco «{query}» (solo Creative Commons)…")
    results = search_music(query)
    if not results:
        send(chat_id, "Nessun risultato Creative Commons. Prova altre parole.")
        return
    POOLS[str(chat_id)] = [url for _title, url in results]
    lines = []
    for i, (title, url) in enumerate(results, start=1):
        short = title if len(title) <= TITLE_MAX else title[: TITLE_MAX - 1] + "…"
        lines.append(f"{i}. {short}\n{url}")
    send(
        chat_id,
        "Pool aggiornato con questi brani Creative Commons:\n\n"
        + "\n\n".join(lines)
        + "\n\nScarica con «/dl <n>» (aggiungi /slow, /fast, /reverb o /speed <n>). "
        "«/pool» per rivederli, «/pool clear» per svuotarlo.",
    )


def handle_pool(chat_id: int | str, text: str) -> None:
    parts = text.split()
    if len(parts) > 1 and parts[1].lower() in ("clear", "reset", "svuota"):
        POOLS.pop(str(chat_id), None)
        send(chat_id, "Pool svuotato.")
        return
    pool = POOLS.get(str(chat_id), [])
    if not pool:
        send(chat_id, "Pool vuoto. Usa «/cerca <parole>» per riempirlo.")
        return
    lines = [f"{i}. {url}" for i, url in enumerate(pool, start=1)]
    send(chat_id, "Pool attuale:\n\n" + "\n".join(lines) + "\n\n«/dl <n>» per scaricare.")


def handle_pool_download(chat_id: int | str, text: str) -> None:
    tokens = text.split()[1:]  # salta /dl
    if not tokens or not tokens[0].isdigit():
        send(chat_id, "Uso: /dl <numero> [/slow | /fast | /reverb | /speed <n>]")
        return
    pool = POOLS.get(str(chat_id), [])
    index = int(tokens[0])
    if index < 1 or index > len(pool):
        send(chat_id, f"Numero fuori dal pool (1–{len(pool)}). «/pool» per vederlo.")
        return
    # Effetto opzionale dal resto: accetta sia «/slow» sia «slow», e «speed 1.1» o «/speed 1.1».
    rest = tokens[1:]
    if rest and not rest[0].startswith("/"):
        rest[0] = "/" + rest[0]
    own, speed, reverb, _rest = parse_command(" ".join(rest))
    process_urls(chat_id, [pool[index - 1]], own, speed, reverb)


def process_urls(
    chat_id: int | str,
    urls: list[str],
    own: bool,
    speed: float = 1.0,
    reverb: bool = False,
) -> None:
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
            transform_and_deliver(chat_id, path, speed, reverb)


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

    # File .txt inviato al bot: equivalente di --urls-file (un URL per riga). La didascalia può
    # portare i comandi (es. «/slow» o «/own») da applicare a tutto il file.
    document = message.get("document")
    if document:
        own, speed, reverb, _rest = parse_command((message.get("caption") or "").strip())
        urls = read_document_urls(document)
        if urls is None:
            send(chat_id, "Non riesco a leggere il file.")
            return
        if not urls:
            send(chat_id, "Il file non contiene URL.")
            return
        if own:
            # /own disattiva il filtro CC: esplicito, mai silenzioso, per un intero file.
            send(
                chat_id,
                "⚠️ /own nella didascalia: filtro Creative Commons DISATTIVATO per tutto il file. "
                "Scarica solo contenuti di cui hai i diritti.",
            )
        process_urls(chat_id, urls, own, speed, reverb)
        return

    text = (message.get("text") or "").strip()
    if text in ("/start", "/help", ""):
        send(
            chat_id,
            "Mandami uno o più link (anche uno per riga), oppure un file .txt di URL: scarico "
            "l'audio in MP3 SOLO se ha licenza Creative Commons.\n\n"
            "Cerca e pool di link:\n"
            "• /cerca <parole> — cerca brani Creative Commons e aggiorna il pool\n"
            "• /pool — mostra il pool  ·  /pool clear — svuotalo\n"
            "• /dl <n> — scarica il brano n del pool (aggiungi /slow, /fast, /reverb, /speed <n>)\n\n"
            "Effetti (il tono segue la velocità, stile «slowed/sped up»):\n"
            "• /slow <link> — rallentato (x0.85)\n"
            "• /reverb <link> — rallentato + eco\n"
            "• /fast <link> — accelerato / nightcore (x1.25)\n"
            "• /speed <fattore> <link> — velocità a scelta (0.5–2, es. /speed 1.1)\n\n"
            "Usa «/own <link>» per un contenuto TUO (toglie il filtro CC; devi averne i diritti); "
            "puoi combinarlo, es. «/own /slow <link>».\n"
            f"Domini consentiti: {', '.join(sorted(ALLOWED_DOMAINS))}.",
        )
        return

    command = text.split(None, 1)[0].split("@", 1)[0].lower()
    argument = text.split(None, 1)[1].strip() if len(text.split(None, 1)) > 1 else ""
    if command in ("/cerca", "/search", "/trova"):
        handle_search(chat_id, argument)
        return
    if command in ("/pool", "/lista"):
        handle_pool(chat_id, text)
        return
    if command in ("/dl", "/scarica"):
        handle_pool_download(chat_id, text)
        return

    own, speed, reverb, rest = parse_command(text)
    urls = extract_urls(rest)
    if not urls:
        send(
            chat_id,
            "Mandami uno o più URL http(s), un file .txt, oppure cerca con «/cerca <parole>». "
            "/help per le istruzioni.",
        )
        return
    process_urls(chat_id, urls, own, speed, reverb)


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

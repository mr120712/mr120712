#!/usr/bin/env python3
# Misura, dalla macchina su cui gira, quali configurazioni di yt-dlp superano il controllo anti-bot
# di YouTube («Sign in to confirm you're not a bot»). Serve a decidere con dati reali che cosa
# mettere nella scala di tentativi del worker (workers/ytdlp-worker): i runner di GitHub Actions
# hanno IP da datacenter, come Render, e a differenza della sandbox di sviluppo raggiungono YouTube.
#
# Ogni configurazione è una voce JSON:
#   {"name": "...", "clients": ["web"], "pot": "never|auto|always", "player_skip": ["webpage"],
#    "impersonate": "chrome"}
# `pot` governa i PO Token (youtube:fetch_pot): "never" = come se il provider non ci fosse.
# PROBE_PROXY fa uscire ogni richiesta da un proxy (per misurare un'altra uscita, es. una VPN locale):
# in quel caso girano solo le configurazioni senza PO Token, perché il provider non passa dal proxy.
# Nessun segreto: solo richieste anonime a YouTube. Esce sempre con 0: è una misura, non un test.
import json
import os
import re
import sys
import tempfile
import time
from pathlib import Path

import yt_dlp

# Lo stesso formato che chiede il worker: audio+video in un file solo.
FORMAT = "best[acodec!=none][vcodec!=none]/best"

DEFAULT_CONFIGS = [
    # Senza PO Token: quello che il worker fa oggi, più i client che non ne hanno bisogno.
    {"name": "default"},
    {"name": "web_embedded", "clients": ["web_embedded"]},
    {"name": "tv", "clients": ["tv"]},
    {"name": "tv_downgraded", "clients": ["tv_downgraded"]},
    {"name": "tv_samsung", "clients": ["tv_samsung"]},
    {"name": "visionos", "clients": ["visionos"]},
    {"name": "web_safari", "clients": ["web_safari"]},
    {"name": "mweb", "clients": ["mweb"]},
    {"name": "android_vr", "clients": ["android_vr"]},
    {"name": "tv_simply", "clients": ["tv_simply"]},
    {"name": "default-senza-pagina", "player_skip": ["webpage"]},
    # Con il provider di PO Token (BotGuard).
    {"name": "pot/default", "pot": "auto"},
    {"name": "pot/default+always", "pot": "always"},
    {"name": "pot/web", "clients": ["web"], "pot": "always"},
    {"name": "pot/web_safari", "clients": ["web_safari"], "pot": "always"},
    {"name": "pot/mweb", "clients": ["mweb"], "pot": "always"},
    {"name": "pot/web_embedded", "clients": ["web_embedded"], "pot": "always"},
    {"name": "pot/tv", "clients": ["tv"], "pot": "always"},
    {"name": "pot/tv_simply", "clients": ["tv_simply"], "pot": "always"},
    {"name": "pot/web_music", "clients": ["web_music"], "pot": "always"},
]

PROXY = os.environ.get("PROBE_PROXY", "").strip()

# Le righe del log di yt-dlp che spiegano un esito.
INTERESTING = re.compile(
    r"playability status|po token|\[pot|sign in|not a bot|skipp|forbidden|http error|"
    r"^error|^warning|unavailable|player =|providers",
    re.IGNORECASE,
)


# …e quelle che lo coprono soltanto (nuovi tentativi di rete, provider a script non installati).
NOISE = re.compile(r"retrying \(|script path|server_home|^error:\s+file ", re.IGNORECASE)


class Capture:
    """Raccoglie tutto ciò che yt-dlp scriverebbe a schermo."""

    def __init__(self) -> None:
        self.lines: list[str] = []

    def debug(self, message: str) -> None:
        self.lines.append(message)

    info = debug

    def warning(self, message: str) -> None:
        self.lines.append(f"WARNING: {message}")

    def error(self, message: str) -> None:
        self.lines.append(f"ERROR: {message}")


def classify(text: str) -> str:
    """Gli stessi codici di _classify_error nel worker, più `no_formats`."""
    text = text.replace("’", "'").lower()
    if "not a bot" in text:
        return "youtube_bot_check"
    if "http error 429" in text or "too many requests" in text or "try again later" in text:
        return "rate_limited"
    if "sign in" in text or "login required" in text or "members-only" in text or "private video" in text:
        return "login_required"
    if "video unavailable" in text or "is unavailable" in text or "has been removed" in text:
        return "unavailable"
    if "requested format is not available" in text or "no video formats" in text:
        return "no_formats"
    return "failed"


def options(config: dict, capture: Capture) -> dict:
    youtube: dict[str, list[str]] = {"fetch_pot": [config.get("pot", "never")]}
    if config.get("clients"):
        youtube["player_client"] = config["clients"]
    if config.get("player_skip"):
        youtube["player_skip"] = config["player_skip"]
    opts: dict = {
        "logger": capture,
        "verbose": True,
        "noprogress": True,
        "noplaylist": True,
        "socket_timeout": 30,
        "retries": 2,
        "fragment_retries": 2,
        "format": FORMAT,
        "extractor_args": {"youtube": youtube},
    }
    if PROXY:
        opts["proxy"] = PROXY
    if config.get("impersonate"):
        from yt_dlp.networking.impersonate import ImpersonateTarget

        opts["impersonate"] = ImpersonateTarget.from_str(config["impersonate"])
    return opts


def attempt(config: dict, url: str, download_dir: Path | None) -> dict:
    capture = Capture()
    opts = options(config, capture)
    if download_dir:
        opts.update(outtmpl=str(download_dir / "%(id)s.%(ext)s"), max_filesize=120 * 1024 * 1024)
    started = time.monotonic()
    result: dict = {"name": config["name"], "outcome": "ok", "error": ""}
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=bool(download_dir))
            formats = info.get("formats") or []
            chosen = next((f for f in formats if f.get("format_id") == info.get("format_id")), {})
            result.update(
                clients=",".join(sorted({f["_client"] for f in formats if f.get("_client")})) or "?",
                format=f"{info.get('format_id')} {info.get('ext')} {info.get('resolution')} "
                f"via {chosen.get('_client', '?')} ({info.get('protocol')})",
                formats=len(formats),
            )
            if download_dir:
                path = Path(ydl.prepare_filename(info))
                result["bytes"] = path.stat().st_size if path.is_file() else 0
                if not result["bytes"]:
                    result.update(outcome="download_failed", error="nessun file scritto")
    except Exception as exc:  # il motivo è nel testo di DownloadError/ExtractorError
        result.update(outcome=classify(str(exc)), error=str(exc)[:220])
    result["seconds"] = round(time.monotonic() - started, 1)
    result["tokens"] = sum("Generating a" in line and "PO Token" in line for line in capture.lines)
    first_lines = (line.split("\n", 1)[0] for line in capture.lines)
    result["log"] = [line[:260] for line in first_lines if INTERESTING.search(line) and not NOISE.search(line)][:30]
    return result


def describe(result: dict) -> str:
    fields = [f"{result['outcome']:<18}", f"{result['seconds']:>5}s", f"token={result['tokens']}"]
    for key in ("clients", "format", "bytes", "error"):
        if result.get(key):
            fields.append(f"{key}={result[key]}")
    return f"{result['name']:<22} " + "  ".join(fields)


def main() -> int:
    url = os.environ.get("PROBE_URL", "").strip() or "https://www.youtube.com/watch?v=hTWKbfoikeg"
    raw = os.environ.get("PROBE_CONFIGS", "").strip()
    configs = json.loads(raw) if raw else DEFAULT_CONFIGS
    if PROXY and not raw:
        configs = [config for config in configs if "pot" not in config]
    pause = float(os.environ.get("PROBE_PAUSE", "4"))
    download = os.environ.get("PROBE_DOWNLOAD", "ok").strip().lower() == "ok"
    download_max = int(os.environ.get("PROBE_DOWNLOAD_MAX", "4"))
    exit_point = "da un proxy" if PROXY else "diretta"
    print(f"yt-dlp {yt_dlp.version.__version__} · {url} · {len(configs)} configurazioni · uscita {exit_point}", flush=True)

    results = []
    for index, config in enumerate(configs):
        if index:
            time.sleep(pause)
        result = attempt(config, url, None)
        results.append(result)
        print(f"\n=== {describe(result)}", flush=True)
        for line in result["log"]:
            print(f"    {line}", flush=True)

    passed = [config for config, result in zip(configs, results) if result["outcome"] == "ok"]
    downloads = []
    if download and passed:
        print("\n##### Download completo delle configurazioni che hanno superato l'estrazione", flush=True)
        for config in passed[:download_max]:
            time.sleep(pause)
            with tempfile.TemporaryDirectory() as folder:
                result = attempt(config, url, Path(folder))
            downloads.append(result)
            print(f"\n=== {describe(result)}", flush=True)
            for line in result["log"]:
                if re.search(r"error|forbidden|warning", line, re.IGNORECASE):
                    print(f"    {line}", flush=True)

    print("\n##### Riepilogo", flush=True)
    for result in results:
        print(describe(result), flush=True)
    for result in downloads:
        print(f"download · {describe(result)}", flush=True)

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        rows = ["| Configurazione | Esito | Secondi | Token | Formato / errore |", "|---|---|---|---|---|"]
        for label, group in (("", results), ("download · ", downloads)):
            for result in group:
                detail = (result.get("format") or result.get("error") or "").replace("|", "/")
                if result.get("bytes"):
                    detail += f" · {result['bytes']} byte"
                rows.append(
                    f"| {label}{result['name']} | {result['outcome']} | {result['seconds']} | "
                    f"{result['tokens']} | {detail} |"
                )
        Path(summary).open("a").write(
            f"### Controllo anti-bot · {url} · uscita {exit_point}\n\n" + "\n".join(rows) + "\n\n"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
yt-dlp-cc-download.py — scarica audio IN LOCALE, solo da fonti consentite.

Strumento locale (NON fa parte del sito Solco). Scarica brani su cui HAI il diritto:
  • DEFAULT: solo video YouTube con licenza **Creative Commons** — il filtro è imposto da
    yt-dlp sul campo `license`, quindi i video "Standard YouTube License" vengono SALTATI.
  • --own-channel: scarichi contenuti che dichiari TUOI (ne sei il proprietario). In questa
    modalità il filtro CC è tolto e la responsabilità sui diritti è tua.

NON usarlo per scaricare musica protetta di terzi: è violazione di copyright e dei Termini
di YouTube. Questo script non aggira alcuna protezione e si limita a ciò che è lecito.

Requisiti:
  pip install -U yt-dlp            # oppure: brew install yt-dlp / pipx install yt-dlp
  ffmpeg (solo per --mp3):  brew install ffmpeg  /  apt-get install ffmpeg

Esempi:
  # Lista di URL (uno per riga, '#' per i commenti): scarica SOLO quelli con licenza CC
  python3 scripts/yt-dlp-cc-download.py --urls-file urls.txt --out ./download

  # Un singolo video CC, estratto in MP3
  python3 scripts/yt-dlp-cc-download.py "https://www.youtube.com/watch?v=XXXX" --mp3 --out ./download

  # Il TUO canale (confermi di esserne il proprietario): toglie il filtro CC
  python3 scripts/yt-dlp-cc-download.py --own-channel "https://www.youtube.com/@iltuocanale" --mp3
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys

# Filtro match-filter di yt-dlp: tiene SOLO i contenuti la cui licenza contiene "creative commons"
# (case-insensitive). I video senza questo campo (es. licenza standard) vengono scartati.
CC_MATCH_FILTER = "license ~= (?i)creative commons"


def require(tool: str) -> None:
    if shutil.which(tool) is None:
        sys.exit(f"Manca «{tool}». Installalo prima (vedi l'intestazione dello script).")


def read_urls(args: argparse.Namespace) -> list[str]:
    urls = list(args.urls)
    if args.urls_file:
        try:
            with open(args.urls_file, encoding="utf-8") as handle:
                for line in handle:
                    stripped = line.strip()
                    if stripped and not stripped.startswith("#"):
                        urls.append(stripped)
        except OSError as error:
            sys.exit(f"Non riesco a leggere {args.urls_file}: {error}")
    return urls


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Scarica audio in locale solo da fonti consentite (Creative Commons o tuo canale).",
    )
    parser.add_argument("urls", nargs="*", help="URL di video, playlist o canale.")
    parser.add_argument("--urls-file", help="File di testo con un URL per riga ('#' = commento).")
    parser.add_argument("--out", default="download", help="Cartella di output (default: ./download).")
    parser.add_argument(
        "--own-channel",
        action="store_true",
        help="Gli URL sono TUOI (ne sei il proprietario): toglie il filtro Creative Commons.",
    )
    parser.add_argument(
        "--mp3",
        action="store_true",
        help="Estrai l'audio in MP3 (richiede ffmpeg). Senza, scarica il file audio originale.",
    )
    parser.add_argument(
        "--format",
        default="bestaudio/best",
        help="Selettore di formato yt-dlp (default: bestaudio/best).",
    )
    args = parser.parse_args()

    require("yt-dlp")

    urls = read_urls(args)
    if not urls:
        sys.exit("Nessun URL da scaricare. Passane uno, oppure usa --urls-file urls.txt.")

    cmd = [
        "yt-dlp",
        "-f",
        args.format,
        "-o",
        f"{args.out}/%(uploader)s - %(title)s [%(id)s].%(ext)s",
        "--no-overwrites",
        "--ignore-errors",
    ]

    if args.mp3:
        require("ffmpeg")
        cmd += [
            "--extract-audio",
            "--audio-format",
            "mp3",
            "--audio-quality",
            "0",
            "--embed-metadata",
            "--embed-thumbnail",
        ]

    if args.own_channel:
        print(
            "⚠️  Modalità --own-channel: stai scaricando contenuti che dichiari TUOI.\n"
            "    Procedi solo se ne sei il proprietario o hai i diritti.",
        )
    else:
        cmd += ["--match-filter", CC_MATCH_FILTER]
        print("ℹ️  Scarico SOLO video con licenza Creative Commons; gli altri vengono saltati.")

    cmd += urls
    print("→ " + " ".join(cmd))
    try:
        return subprocess.call(cmd)
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())

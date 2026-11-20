# --- usque: client Cloudflare WARP in spazio utente, per l'uscita di riserva (YTDLP_WARP=1) -------------
# Compilato dal sorgente a un commit fisso (versione 4.2.1): nessun binario scaricato, e il modulo passa
# dal registro di checksum di Go. È un solo eseguibile statico, inerte finché YTDLP_WARP non viene acceso.
FROM golang:1.26-alpine AS warp
RUN CGO_ENABLED=0 GOBIN=/out go install -trimpath -ldflags="-s -w" \
    github.com/Diniboy1123/usque@6aa03fc97d12848dce34eedbd187fb1077b5d1ea

FROM python:3.12-slim

# ffmpeg serve a yt-dlp per unire/riconvertire alcuni formati.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY --from=warp /out/usque /usr/local/bin/usque
COPY app.py .

# Le piattaforme (Fly/Render/Railway) passano $PORT; default 8080.
ENV PORT=8080
EXPOSE 8080

# --proxy-headers + --forwarded-allow-ips così, in modalità "serve", request.base_url è HTTPS (il link
# /file/<id> restituito è corretto dietro il proxy della piattaforma). In alternativa imposta PUBLIC_BASE_URL.
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8080} --proxy-headers --forwarded-allow-ips='*'"]

FROM python:3.12-slim

# ffmpeg serve a yt-dlp per unire/riconvertire alcuni formati.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

# Le piattaforme (Fly/Render/Railway) passano $PORT; default 8080.
ENV PORT=8080
EXPOSE 8080

# Un solo worker: l'estrazione è veloce e il servizio è a basso volume (owner-only).
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8080}"]

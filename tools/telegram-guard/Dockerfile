FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY telegram_guard_pro.py .

# Sessione (auth key!) e stato vivono in un VOLUME /data, così sopravvivono ai restart.
# TG_API_ID / TG_API_HASH vanno passati a runtime come secret (non nell'immagine).
ENV TG_NONINTERACTIVE=1 \
    TG_SESSION_NAME=/data/telegram_guard_pro \
    TG_STATE_PATH=/data/guard_state.json \
    TG_HEARTBEAT_PATH=/data/heartbeat \
    TG_ALERT_CHAT=me

VOLUME ["/data"]
CMD ["python3", "telegram_guard_pro.py"]

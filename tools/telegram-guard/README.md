# Telegram Guard Pro — deploy h24

Monitor **difensivo** delle TUE sessioni Telegram. Avvisa su login nuovi/sospetti, cambi di IP/paese
di una sessione, e (opzionale) revoca da sola i login non confermati. Opera **solo sul tuo account**.

## 1) Bootstrap della sessione (UNA volta, sul tuo computer)

Telethon al primo avvio chiede numero di telefono + codice (+ password 2FA se attiva) e crea il file
`telegram_guard_pro.session` — che contiene la **auth key** ed è un **segreto**. Questo passo è
interattivo, quindi va fatto a mano una volta:

```bash
pip install -r requirements.txt
export TG_API_ID=...        # da https://my.telegram.org
export TG_API_HASH=...
python3 telegram_guard_pro.py        # scegli 1 (monitoraggio) per confermare che funziona, poi Ctrl-C
```

Ora hai `telegram_guard_pro.session`. **Non committarlo, non condividerlo.** Lo porterai sul server.

## 2a) Deploy con systemd (VPS/server Linux)

```bash
sudo useradd --system --home /opt/telegram-guard --shell /usr/sbin/nologin teleguard
sudo mkdir -p /opt/telegram-guard && cd /opt/telegram-guard
sudo python3 -m venv venv && sudo ./venv/bin/pip install -r /path/requirements.txt

# copia lo script e la sessione creata al passo 1
sudo cp telegram_guard_pro.py telegram_guard_pro.session /opt/telegram-guard/

# segreti + config (chmod 600!)
sudo tee guard.env >/dev/null <<'ENV'
TG_API_ID=123456
TG_API_HASH=xxxxxxxxxxxxxxxx
TG_NONINTERACTIVE=1
TG_ALERT_CHAT=me
TG_AUTO_REVOKE_UNCONFIRMED=0
TG_CHECK_INTERVAL=60
ENV
sudo chmod 600 guard.env telegram_guard_pro.session
sudo chown -R teleguard:teleguard /opt/telegram-guard

sudo cp telegram-guard.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now telegram-guard
journalctl -u telegram-guard -f        # log in tempo reale
```

## 2b) Deploy con Docker

```bash
docker build -t telegram-guard .
# metti la sessione creata al passo 1 in un volume:
docker volume create tg-guard
docker run --rm -v tg-guard:/data -v "$PWD/telegram_guard_pro.session:/data/telegram_guard_pro.session:ro" alpine true  # (o copia il file nel volume)

docker run -d --name telegram-guard --restart unless-stopped \
  -v tg-guard:/data \
  -e TG_API_ID=123456 -e TG_API_HASH=xxxx \
  -e TG_ALERT_CHAT=me \
  telegram-guard
docker logs -f telegram-guard
```
> Il container è headless (`TG_NONINTERACTIVE=1`): la sessione DEVE già esistere in `/data`
> (`/data/telegram_guard_pro.session`). Crea il file al passo 1 e copialo nel volume.

## 2c) Deploy su Fly.io (consigliato: sessione come *secret*, niente file)

Qui la sessione NON è un file ma una **stringa** (`TG_SESSION_STRING`) salvata come secret — molto più
pulito in container. Dentro `tools/telegram-guard`:

```bash
# 1) genera la stringa UNA volta, sul tuo computer (login interattivo):
pip install -r requirements.txt
TG_API_ID=123456 TG_API_HASH=xxxx python3 bootstrap_session.py   # stampa TG_SESSION_STRING

# 2) crea app + volume (per lo stato) e imposta i secret:
fly apps create solco-telegram-guard
fly volumes create tg_guard_data --size 1 --region fra
fly secrets set TG_API_ID=123456 TG_API_HASH=xxxx TG_SESSION_STRING="1BVtsO...==" TG_ALERT_CHAT=me

# 3) deploy
fly deploy
fly logs
```

Macchina **sempre accesa** (è un monitor continuo, niente scale-to-zero), 256 MB, nessuna porta in
ingresso. Gli avvisi arrivano nei tuoi **Messaggi salvati**.

## Avvisi dentro Telegram

`TG_ALERT_CHAT=me` → gli avvisi arrivano nei tuoi **Messaggi salvati** (notifica sul tuo Telegram).
Puoi anche mettere `@tuo_canale` o un id numerico. In più/alternativa, `TG_ALERT_WEBHOOK=https://…`
(+ `TG_ALERT_WEBHOOK_TOKEN`) per Slack o un relay.

## Opzioni utili

| Variabile | Effetto |
|---|---|
| `TG_AUTO_REVOKE_UNCONFIRMED=1` | revoca da sola i login **non confermati** appena compaiono |
| `TG_REDACT_IPS=1` | maschera gli IP negli avvisi |
| `TG_ALERT_DEDUPE_SECONDS=3600` | non ripetere lo stesso avviso entro N secondi |
| `TG_HEARTBEAT_PATH=/data/heartbeat` | scrive un timestamp a ogni ciclo (per un watchdog esterno) |

## Difesa aggiuntiva (fortemente consigliata)

Attiva la **Verifica in due passaggi** su Telegram (Impostazioni → Privacy e sicurezza): è la barriera
più forte contro i login non autorizzati, e rende visibile lo stato `password_pending` a questo guard.

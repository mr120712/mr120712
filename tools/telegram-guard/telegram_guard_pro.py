#!/usr/bin/env python3
"""
Telegram Guard Pro — strumento DIFENSIVO per il TUO account Telegram.

Monitora le tue sessioni/autorizzazioni attive (le stesse di «Dispositivi attivi» nell'app),
avvisa su login nuovi o sospetti, su una sessione che cambia IP/paese (possibile hijack o viaggio),
e — in modo opzionale e disattivato di default — revoca da sola le sessioni NON confermate appena
compaiono. Opera SOLO sul tuo account (login con le TUE API_ID/API_HASH); non tocca account altrui.

Variabili d'ambiente:
  TG_API_ID, TG_API_HASH        (obbligatori)        da https://my.telegram.org
  TG_SESSION_NAME               (telegram_guard_pro) nome del file di sessione Telethon
  TG_SESSION_STRING             (opz.)               sessione come STRINGA (per deploy headless/Fly:
                                                     si imposta come secret, niente file da caricare)
  TG_STATE_PATH                 (guard_state.json)   dove salvare la baseline
  TG_CHECK_INTERVAL             (60, minimo 15)      secondi tra i controlli
  TG_ALERT_CHAT                 (opz.)               dove mandare gli avvisi DENTRO Telegram via il
                                                     tuo client: "me" (Messaggi salvati), @canale o id
  TG_ALERT_WEBHOOK              (opz., https://)     dove inviare gli avvisi (Slack/Telegram/...)
  TG_ALERT_WEBHOOK_TOKEN        (opz.)               Bearer da inviare al webhook
  TG_ALERT_DEDUPE_SECONDS       (3600)               non ripetere lo stesso avviso entro N secondi
  TG_REDACT_IPS                 (opz. 1)             maschera gli IP negli avvisi
  TG_AUTO_REVOKE_UNCONFIRMED    (opz. 1)             revoca da sola le sessioni non confermate nuove
  TG_HEARTBEAT_PATH             (opz.)               file con un timestamp a ogni ciclo (watchdog)
  TG_NONINTERACTIVE             (opz. 1)             salta il menu e avvia subito il monitoraggio
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import stat
import sys
import time
from contextlib import suppress
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import aiohttp
from telethon import TelegramClient, functions
from telethon.errors import FloodWaitError, RPCError
from telethon.sessions import StringSession

log = logging.getLogger("tg-guard")


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "on", "yes"}


def utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _secure(path: Path) -> None:
    """chmod 0600 su un file sensibile (sessione/stato: contengono auth key e IP). No-op su Windows."""
    with suppress(OSError):
        path.chmod(stat.S_IRUSR | stat.S_IWUSR)


def mask_ip(ip: str, redact: bool) -> str:
    if not redact or not ip or ip == "?":
        return ip or "?"
    if ":" in ip:  # IPv6
        return ip.split(":", 1)[0] + ":…"
    parts = ip.split(".")
    return (parts[0] + ".x.x.x") if len(parts) == 4 else "x.x.x.x"


@dataclass(frozen=True)
class Config:
    api_id: int
    api_hash: str
    session_name: str
    session_string: str | None
    state_path: Path
    interval: int
    alert_chat: str | None
    webhook: str | None
    webhook_token: str | None
    dedupe_seconds: int
    redact_ips: bool
    auto_revoke_unconfirmed: bool
    heartbeat_path: Path | None

    @staticmethod
    def from_env() -> "Config":
        def need(name: str) -> str:
            value = os.environ.get(name, "").strip()
            if not value:
                raise SystemExit(f"Variabile d'ambiente obbligatoria mancante: {name}")
            return value

        webhook = os.environ.get("TG_ALERT_WEBHOOK", "").strip() or None
        if webhook and not webhook.startswith("https://"):
            raise SystemExit("TG_ALERT_WEBHOOK deve essere un URL https://")
        try:
            api_id = int(need("TG_API_ID"))
        except ValueError:
            raise SystemExit("TG_API_ID deve essere numerico") from None

        return Config(
            api_id=api_id,
            api_hash=need("TG_API_HASH"),
            session_name=os.environ.get("TG_SESSION_NAME", "telegram_guard_pro").strip()
            or "telegram_guard_pro",
            session_string=os.environ.get("TG_SESSION_STRING", "").strip() or None,
            state_path=Path(os.environ.get("TG_STATE_PATH", "guard_state.json")),
            interval=max(15, int(os.environ.get("TG_CHECK_INTERVAL", "60") or "60")),
            alert_chat=os.environ.get("TG_ALERT_CHAT", "").strip() or None,
            webhook=webhook,
            webhook_token=os.environ.get("TG_ALERT_WEBHOOK_TOKEN", "").strip() or None,
            dedupe_seconds=max(0, int(os.environ.get("TG_ALERT_DEDUPE_SECONDS", "3600") or "3600")),
            redact_ips=_truthy(os.environ.get("TG_REDACT_IPS")),
            auto_revoke_unconfirmed=_truthy(os.environ.get("TG_AUTO_REVOKE_UNCONFIRMED")),
            heartbeat_path=(
                Path(os.environ["TG_HEARTBEAT_PATH"])
                if os.environ.get("TG_HEARTBEAT_PATH")
                else None
            ),
        )


# ---------------------------------------------------------------------------
# Sessioni Telegram (identità STABILE = auth.hash; IP/paese cambiano, l'hash no)
# ---------------------------------------------------------------------------
def describe(auth: Any) -> dict[str, Any]:
    return {
        "hash": str(auth.hash),
        "device": auth.device_model or "?",
        "platform": auth.platform or "?",
        "app": f"{auth.app_name or '?'} {auth.app_version or ''}".strip(),
        "api_id": auth.api_id,
        "country": auth.country or "?",
        "ip": auth.ip or "?",
        "current": bool(auth.current),
        "unconfirmed": bool(getattr(auth, "unconfirmed", False)),
        "password_pending": bool(getattr(auth, "password_pending", False)),
        "created": str(auth.date_created),
        "last_active": str(auth.date_active),
    }


def snapshot(auths: list[Any]) -> dict[str, dict[str, Any]]:
    return {str(a.hash): describe(a) for a in auths}


async def get_sessions(client: TelegramClient) -> list[Any]:
    result = await client(functions.account.GetAuthorizationsRequest())
    return list(result.authorizations)


async def revoke_one(client: TelegramClient, hash_str: str) -> bool:
    """Revoca UNA sessione per hash (non tocca le altre)."""
    try:
        await client(functions.account.ResetAuthorizationRequest(hash=int(hash_str)))
        return True
    except (RPCError, ValueError) as exc:
        log.error("Revoca sessione %s fallita: %s", hash_str, type(exc).__name__)
        return False


# ---------------------------------------------------------------------------
# Avvisi: log strutturato + webhook, con severità e anti-ripetizione
# ---------------------------------------------------------------------------
class Alerts:
    _LEVEL = {"critical": logging.ERROR, "warning": logging.WARNING, "info": logging.INFO}

    def __init__(self, cfg: Config, http: aiohttp.ClientSession, client: TelegramClient) -> None:
        self.cfg = cfg
        self.http = http
        self.client = client
        self._last: dict[str, float] = {}

    async def send(
        self,
        *,
        event: str,
        severity: str,
        text: str,
        key: str | None = None,
        session: dict[str, Any] | None = None,
    ) -> None:
        dedupe = f"{event}:{key or text}"
        now = time.monotonic()
        if (prev := self._last.get(dedupe)) is not None and now - prev < self.cfg.dedupe_seconds:
            return
        self._last[dedupe] = now

        line = f"[{severity.upper()}] {text}"
        log.log(self._LEVEL.get(severity, logging.INFO), "%s", line)

        # Sink 1 — Telegram, tramite il tuo client già autenticato (es. "me" = Messaggi salvati).
        if self.cfg.alert_chat:
            try:
                await self.client.send_message(self.cfg.alert_chat, line)
            except Exception as exc:  # noqa: BLE001 — best-effort
                log.warning("Invio avviso a Telegram fallito: %s", type(exc).__name__)

        # Sink 2 — webhook HTTPS (Slack/relay/...).
        if not self.cfg.webhook:
            return
        payload: dict[str, Any] = {
            "text": line,
            "severity": severity,
            "event": event,
            "ts": utc(),
        }
        if session:
            masked = dict(session)
            masked["ip"] = mask_ip(masked.get("ip", "?"), self.cfg.redact_ips)
            payload["session"] = masked
        headers = (
            {"Authorization": f"Bearer {self.cfg.webhook_token}"} if self.cfg.webhook_token else {}
        )
        try:
            async with self.http.post(
                self.cfg.webhook,
                json=payload,
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=10),
            ) as response:
                response.raise_for_status()
        except Exception as exc:  # noqa: BLE001 — best-effort, non deve fermare il monitoraggio
            log.warning("Invio avviso al webhook fallito: %s", type(exc).__name__)


# ---------------------------------------------------------------------------
# Stato persistente (scrittura atomica + permessi 0600)
# ---------------------------------------------------------------------------
def load_state(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (ValueError, OSError) as exc:
        log.warning("Stato non leggibile (%s): riparto dalla baseline.", type(exc).__name__)
        return {}


def save_state(path: Path, state: dict[str, Any]) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")
    _secure(tmp)
    tmp.replace(path)
    _secure(path)


# ---------------------------------------------------------------------------
# Diff e valutazione: nuove, sparite, e CAMBIATE (stesso hash, IP/paese diverso)
# ---------------------------------------------------------------------------
async def evaluate(
    client: TelegramClient,
    cfg: Config,
    alerts: Alerts,
    previous: dict[str, Any],
    current: dict[str, Any],
) -> None:
    added = set(current) - set(previous)
    removed = set(previous) - set(current)
    common = set(current) & set(previous)

    for key in added:
        item = current[key]
        if item["current"]:
            continue
        where = (
            f"{item['device']} · {item['platform']} · {item['country']} · "
            f"{mask_ip(item['ip'], cfg.redact_ips)}"
        )
        if item["unconfirmed"]:
            await alerts.send(
                event="new_unconfirmed",
                severity="critical",
                key=key,
                text=f"Nuova sessione NON confermata: {where}",
                session=item,
            )
            if cfg.auto_revoke_unconfirmed:
                ok = await revoke_one(client, key)
                await alerts.send(
                    event="auto_revoke",
                    severity="critical",
                    key=key,
                    text=f"Auto-revoca sessione non confermata {'riuscita' if ok else 'FALLITA'}: {where}",
                )
        else:
            await alerts.send(
                event="new_session",
                severity="warning",
                key=key,
                text=f"Nuova sessione Telegram: {where}",
                session=item,
            )

    for key in removed:
        item = previous[key]
        await alerts.send(
            event="session_gone",
            severity="info",
            key=key,
            text=f"Sessione sparita: {item['device']} · {item['country']}",
            session=item,
        )

    for key in common:
        was, now_ = previous[key], current[key]
        if now_["current"]:
            continue
        changes: list[str] = []
        if was["ip"] != now_["ip"]:
            changes.append(
                f"IP {mask_ip(was['ip'], cfg.redact_ips)} → {mask_ip(now_['ip'], cfg.redact_ips)}"
            )
        if was["country"] != now_["country"]:
            changes.append(f"paese {was['country']} → {now_['country']}")
        if changes:
            await alerts.send(
                event="session_moved",
                severity="warning",
                key=key,
                text=f"Sessione cambiata ({now_['device']}): " + ", ".join(changes),
                session=now_,
            )
        if now_["unconfirmed"] and not was["unconfirmed"]:
            await alerts.send(
                event="became_unconfirmed",
                severity="critical",
                key=key,
                text=f"Sessione ora NON confermata: {now_['device']} · {now_['country']}",
                session=now_,
            )


async def _sleep_or_stop(stop: asyncio.Event, seconds: float) -> None:
    with suppress(asyncio.TimeoutError):
        await asyncio.wait_for(stop.wait(), timeout=seconds)


async def monitor(client: TelegramClient, cfg: Config, alerts: Alerts, stop: asyncio.Event) -> None:
    me = await client.get_me()
    log.info("Monitoraggio account id=%s (@%s), ogni %ss.", me.id, me.username, cfg.interval)
    previous = load_state(cfg.state_path)
    if not previous:
        log.info("Primo avvio: registro la baseline senza avvisare.")
    backoff = cfg.interval

    while not stop.is_set():
        try:
            auths = await get_sessions(client)
            current = snapshot(auths)
            if previous:
                await evaluate(client, cfg, alerts, previous, current)
            previous = current
            save_state(cfg.state_path, previous)
            if cfg.heartbeat_path:
                with suppress(OSError):
                    cfg.heartbeat_path.write_text(utc(), encoding="utf-8")
            log.info("Controllate %d sessioni.", len(auths))
            backoff = cfg.interval
        except FloodWaitError as exc:
            log.warning("FloodWait dall'API: attendo %ss.", exc.seconds)
            await _sleep_or_stop(stop, exc.seconds + 1)
            continue
        except RPCError as exc:
            await alerts.send(
                event="api_error", severity="warning", text=f"Errore API Telegram: {type(exc).__name__}"
            )
        except Exception as exc:  # noqa: BLE001 — il monitoraggio non deve morire per un errore transitorio
            log.error("Errore nel ciclo: %s", type(exc).__name__)
            backoff = min(backoff * 2, 900)
        await _sleep_or_stop(stop, backoff)

    log.info("Arresto richiesto, esco dal monitoraggio.")


# ---------------------------------------------------------------------------
# Menu interattivo (elenco / revoca singola / revoca tutte, con conferma)
# ---------------------------------------------------------------------------
async def list_sessions(client: TelegramClient, cfg: Config) -> list[Any]:
    auths = await get_sessions(client)
    print(f"\n{len(auths)} sessioni:")
    for index, auth in enumerate(auths):
        d = describe(auth)
        tag = "← ATTUALE" if d["current"] else ("⚠ NON CONFERMATA" if d["unconfirmed"] else "")
        print(
            f"  [{index}] {d['device']} · {d['platform']} · {d['country']} · "
            f"{mask_ip(d['ip'], cfg.redact_ips)}  {tag}"
        )
    return auths


async def _ask(prompt: str) -> str:
    return (await asyncio.to_thread(input, prompt)).strip()


async def revoke_menu(client: TelegramClient, cfg: Config) -> None:
    auths = await list_sessions(client, cfg)
    others = [a for a in auths if not a.current]
    if not others:
        print("Nessun'altra sessione da revocare.")
        return
    choice = await _ask("\nIndice da revocare, 'all' per tutte, invio per annullare: ")
    if not choice:
        print("Annullato.")
        return
    if choice.lower() == "all":
        if await _ask("Scrivi  REVOCA TUTTE  per confermare: ") != "REVOCA TUTTE":
            print("Annullato.")
            return
        with suppress(RPCError):
            await client(functions.account.ResetAuthorizationsRequest())
        for _ in range(5):
            await asyncio.sleep(2)
            if not [a for a in await get_sessions(client) if not a.current]:
                print("VERIFICATO: nessun'altra sessione.")
                return
        print("INCOMPLETO: alcune sessioni risultano ancora attive.")
        return
    try:
        target = auths[int(choice)]
    except (ValueError, IndexError):
        print("Indice non valido.")
        return
    if target.current:
        print("Non puoi revocare la sessione attuale.")
        return
    print("Revocata." if await revoke_one(client, str(target.hash)) else "Revoca fallita.")


async def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stderr
    )
    cfg = Config.from_env()
    # Sessione: da STRINGA (secret, per deploy headless) se c'è, altrimenti dal file locale.
    session = StringSession(cfg.session_string) if cfg.session_string else cfg.session_name
    client = TelegramClient(session, cfg.api_id, cfg.api_hash)
    headless = _truthy(os.environ.get("TG_NONINTERACTIVE"))
    if headless:
        # Headless (Render/Fly): mai chiedere telefono/codice su stdin — fallirebbe con EOFError.
        await client.connect()
        if not await client.is_user_authorized():
            logging.error(
                "Sessione mancante o non valida: imposta il secret TG_SESSION_STRING "
                "(generalo sul TUO computer con bootstrap_session.py). Esco."
            )
            await client.disconnect()
            sys.exit(2)
    else:
        await client.start()
    if not cfg.session_string:
        _secure(Path(f"{cfg.session_name}.session"))  # il file di sessione contiene la auth key

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with suppress(NotImplementedError):
            loop.add_signal_handler(sig, stop.set)

    async with aiohttp.ClientSession() as http:
        alerts = Alerts(cfg, http, client)
        try:
            interactive = sys.stdin and sys.stdin.isatty() and not _truthy(
                os.environ.get("TG_NONINTERACTIVE")
            )
            if not interactive:
                await monitor(client, cfg, alerts, stop)
            else:
                print(
                    "\nTELEGRAM GUARD PRO (difensivo)\n"
                    "  1) Monitoraggio continuo\n"
                    "  2) Elenca sessioni\n"
                    "  3) Revoca sessioni\n"
                    "  4) Esci"
                )
                choice = await _ask("Scegli: ")
                if choice == "1":
                    await monitor(client, cfg, alerts, stop)
                elif choice == "2":
                    await list_sessions(client, cfg)
                elif choice == "3":
                    await revoke_menu(client, cfg)
        finally:
            await client.disconnect()


if __name__ == "__main__":
    with suppress(KeyboardInterrupt):
        asyncio.run(main())

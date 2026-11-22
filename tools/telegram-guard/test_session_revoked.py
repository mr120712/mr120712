# Il guard deve FERMARSI con un errore chiaro quando la sua sessione viene revocata, invece di ritentare
# in silenzio per sempre. Nessuna rete: client finto. Esegui dalla cartella del guard:
#   pip install -r requirements.txt && python -m unittest -v test_session_revoked
import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from telethon.errors import AuthKeyUnregisteredError

import telegram_guard_pro as guard


def _cfg(tmp: str) -> guard.Config:
    return guard.Config(
        api_id=1,
        api_hash="x",
        session_name="t",
        session_string=None,
        state_path=Path(tmp) / "state.json",
        interval=15,
        alert_chat=None,
        webhook=None,
        webhook_token=None,
        dedupe_seconds=0,
        redact_ips=False,
        auto_revoke_unconfirmed=False,
        heartbeat_path=None,
    )


class FakeClient:
    def __init__(self, authorized: bool, connect_fails: bool = False):
        self.authorized = authorized
        self.connect_fails = connect_fails

    async def get_me(self):
        return mock.Mock(id=1, username="solco")

    def is_connected(self):
        return False

    async def connect(self):
        if self.connect_fails:
            raise ConnectionError("still down")

    async def is_user_authorized(self):
        return self.authorized


def run_monitor(client, get_sessions, cycles_before_stop=3):
    async def go():
        stop = asyncio.Event()
        alerts = mock.Mock(send=mock.AsyncMock())
        calls = {"n": 0}

        async def sessions(_client):
            calls["n"] += 1
            if calls["n"] >= cycles_before_stop:
                stop.set()
            return await get_sessions(_client)

        async def no_sleep(_stop, _seconds):
            await asyncio.sleep(0)

        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(
            guard, "get_sessions", sessions
        ), mock.patch.object(guard, "_sleep_or_stop", no_sleep):
            await guard.monitor(client, _cfg(tmp), alerts, stop)
        return alerts, calls["n"]

    return asyncio.run(go())


class SessionRevokedTest(unittest.TestCase):
    def test_unauthorized_error_exits_with_code_3(self):
        async def revoked(_client):
            raise AuthKeyUnregisteredError(request=None)

        with self.assertRaises(SystemExit) as ctx:
            run_monitor(FakeClient(authorized=False), revoked)
        self.assertEqual(ctx.exception.code, guard.SESSION_REVOKED_EXIT)

    def test_connection_error_with_revoked_session_exits(self):
        # Il caso visto su Render: Telethon logga INFO, si disconnette, il ciclo vede ConnectionError.
        async def disconnected(_client):
            raise ConnectionError("Cannot send requests while disconnected")

        with self.assertRaises(SystemExit) as ctx:
            run_monitor(FakeClient(authorized=False), disconnected)
        self.assertEqual(ctx.exception.code, guard.SESSION_REVOKED_EXIT)

    def test_transient_network_error_keeps_monitoring(self):
        async def flaky(_client):
            raise ConnectionError("network blip")

        # Sessione ancora valida (o rete ancora giù): NON deve uscire, continua i cicli.
        _alerts, n = run_monitor(FakeClient(authorized=True), flaky)
        self.assertEqual(n, 3)
        _alerts, n = run_monitor(FakeClient(authorized=False, connect_fails=True), flaky)
        self.assertEqual(n, 3)


if __name__ == "__main__":
    unittest.main()

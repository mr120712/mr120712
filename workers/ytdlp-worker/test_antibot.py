# Test dell'anti-bot del worker: yt-dlp è sostituito da un finto che recita un copione per client
# (nessuna rete). Esegui dalla cartella del worker:
#   pip install -r requirements.txt httpx && python -m unittest -v test_antibot
import contextlib
import io
import os
import socket
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_TMP = tempfile.mkdtemp(prefix="ytdlp-worker-test-")
os.environ.update(
    WORKER_API_KEY="test-key",
    WORKER_MODE="extract",
    DOWNLOAD_DIR=_TMP,
    YTDLP_FALLBACK_CLIENTS="tv,android_vr",
    YTDLP_PLAYER_CLIENT="",
    YTDLP_PROXY="",
)
os.environ.pop("YTDLP_SERVICE_KEY", None)

import yt_dlp  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import app as worker  # noqa: E402

AUTH = {"authorization": "Bearer test-key"}
BOT_CHECK = "ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies for the authentication."
# Testi reali di yt-dlp 2026.10.26 con un proxy che rifiuta (407 sul tunnel) o che non risponde.
PROXY_407 = (
    "ERROR: [youtube] abc: Unable to download API page: ('Unable to connect to proxy', OSError('Tunnel "
    "connection failed: 407 Proxy Authentication Required')) (caused by ProxyError(...))"
)
PROXY_URL = "http://customer-1234:s3cret@proxy.example.com:8080"


class FakeYDL:
    """Finto YoutubeDL: `script` associa l'etichetta del client al comportamento ("ok" o un testo d'errore)."""

    script: dict[str, str] = {}
    calls: list[str] = []

    def __init__(self, opts: dict):
        self.opts = opts
        clients = (opts.get("extractor_args") or {}).get("youtube", {}).get("player_client")
        self.label = ",".join(clients) if clients else "default"

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def extract_info(self, _target, download=False, process=True):
        FakeYDL.calls.append(self.label)
        behavior = FakeYDL.script.get(self.label, "ok")
        template = self.opts.get("outtmpl")
        if download and template:
            # Come yt-dlp: un tentativo fallito lascia un file parziale, uno riuscito il file finale.
            suffix = "mp4" if behavior == "ok" else "mp4.part"
            Path(template.replace("%(ext)s", suffix)).write_bytes(b"x" * 10)
        if behavior != "ok":
            raise yt_dlp.utils.DownloadError(behavior)
        return {"url": "https://cdn.example.com/v.mp4", "title": "Titolo", "ext": "mp4", "duration": 12}

    def prepare_filename(self, info):
        return self.opts["outtmpl"].replace("%(ext)s", info["ext"])


class AntibotTest(unittest.TestCase):
    def setUp(self):
        FakeYDL.script, FakeYDL.calls = {}, []
        worker._PREFERRED_CLIENT = None
        worker._LAST_OUTCOME.update(status=None, client=None, at=None)
        patcher = mock.patch.object(worker.yt_dlp, "YoutubeDL", FakeYDL)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.client = TestClient(worker.app)

    def post(self, **headers):
        return self.client.post("/download", json={"url": "https://youtu.be/abc"}, headers=headers or AUTH)

    def test_classifies_yt_dlp_errors(self):
        cases = {
            BOT_CHECK: "youtube_bot_check",
            "Sign in to confirm you're not a bot": "youtube_bot_check",
            "HTTP Error 429: Too Many Requests": "rate_limited",
            "Sign in to confirm your age. This video may be inappropriate": "login_required",
            "Private video. Sign in if you've been granted access": "login_required",
            "Video unavailable. This video has been removed by the uploader": "unavailable",
            "Unable to download webpage: timed out": "failed",
            PROXY_407: "proxy_error",
            # Il proxy che risponde 429 sul tunnel è un rifiuto del proxy, non un limite di YouTube.
            "('Unable to connect to proxy', OSError('Tunnel connection failed: 429 Too Many Requests'))": "proxy_error",
            "('[Errno 5] Connection refused', Socks5Error(5, 'Connection refused')) (caused by ProxyError(...))": (
                "proxy_error"
            ),
            # Un proxy SOCKS irraggiungibile non nomina il proxy: si riconosce dalla connessione Socks.
            "SocksHTTPSConnection(host='www.youtube.com', port=443): Failed to establish a new connection: "
            "[Errno 111] Connection refused (caused by TransportError(...))": "proxy_error",
        }
        for text, expected in cases.items():
            self.assertEqual(worker._classify_error(Exception(text)), expected, text)

    def test_bot_check_falls_back_to_other_clients_and_remembers_the_winner(self):
        FakeYDL.script = {"default": BOT_CHECK, "tv": BOT_CHECK}
        res = self.post()
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.json()["url"], "https://cdn.example.com/v.mp4")
        self.assertEqual(FakeYDL.calls, ["default", "tv", "android_vr"])

        # Il client che ha superato il controllo è provato per primo alla richiesta successiva.
        FakeYDL.calls = []
        self.assertEqual(self.post().status_code, 200)
        self.assertEqual(FakeYDL.calls, ["android_vr"])
        health = self.client.get("/health").json()["antibot"]
        self.assertEqual(health["preferred_client"], "android_vr")
        self.assertEqual(health["last"]["status"], "ok")

    def test_bot_check_on_every_client_returns_a_specific_code(self):
        FakeYDL.script = {"default": BOT_CHECK, "tv": BOT_CHECK, "android_vr": BOT_CHECK}
        res = self.post()
        self.assertEqual(res.status_code, 502)
        self.assertEqual(res.json()["detail"], "youtube_bot_check")
        self.assertEqual(FakeYDL.calls, ["default", "tv", "android_vr"])
        self.assertEqual(self.client.get("/health").json()["antibot"]["last"]["status"], "youtube_bot_check")

    def test_other_errors_do_not_rotate_clients(self):
        FakeYDL.script = {"default": "Video unavailable. This video has been removed by the uploader"}
        res = self.post()
        self.assertEqual((res.status_code, res.json()["detail"]), (502, "unavailable"))
        self.assertEqual(FakeYDL.calls, ["default"])

    def test_unrecognised_error_keeps_the_generic_detail(self):
        FakeYDL.script = {"default": "Unable to download webpage: timed out"}
        res = self.post()
        self.assertEqual((res.status_code, res.json()["detail"]), (502, "extraction failed"))

    def test_budget_stops_further_attempts(self):
        FakeYDL.script = {"default": BOT_CHECK, "tv": BOT_CHECK}
        with mock.patch.object(worker, "ANTIBOT_BUDGET_SECONDS", 0):
            res = self.post()
        self.assertEqual(res.json()["detail"], "youtube_bot_check")
        self.assertEqual(FakeYDL.calls, ["default"])

    def test_configured_client_is_tried_first_then_fallbacks(self):
        FakeYDL.script = {"ios,web": BOT_CHECK}
        with mock.patch.object(worker, "PLAYER_CLIENT", "ios, web"):
            self.assertEqual(self.post().status_code, 200)
        self.assertEqual(FakeYDL.calls, ["ios,web", "tv"])

    def test_a_preferred_client_that_stops_passing_is_forgotten(self):
        worker._PREFERRED_CLIENT = "tv"
        FakeYDL.script = {"tv": BOT_CHECK}
        self.assertEqual(self.post().status_code, 200)
        self.assertEqual(FakeYDL.calls, ["tv", "default"])
        self.assertIsNone(worker._PREFERRED_CLIENT)

    def test_probe_requires_the_key_and_reports_the_outcome(self):
        self.assertEqual(self.client.get("/antibot").status_code, 401)

        FakeYDL.script = {"default": BOT_CHECK, "tv": BOT_CHECK, "android_vr": BOT_CHECK}
        blocked = self.client.get("/antibot", headers=AUTH).json()
        self.assertEqual(blocked["youtube"], "youtube_bot_check")
        self.assertIsNone(blocked["client"])
        self.assertEqual(blocked["tried"], ["default", "tv", "android_vr"])
        self.assertIn("YTDLP_COOKIES", blocked["hint"])

        FakeYDL.script = {"default": BOT_CHECK}
        passed = self.client.get("/antibot", headers=AUTH).json()
        self.assertEqual((passed["youtube"], passed["client"]), ("ok", "tv"))

    def test_serve_mode_removes_partial_files_between_attempts(self):
        FakeYDL.script = {"default": BOT_CHECK}
        with mock.patch.object(worker, "MODE", "serve"):
            res = self.post()
        self.assertEqual(res.status_code, 200, res.text)
        files = sorted(path.name for path in Path(_TMP).iterdir())
        self.assertEqual(len(files), 1, files)
        self.assertTrue(files[0].endswith(".mp4"))
        self.assertIn(f"/file/{files[0]}?exp=", res.json()["url"])
        self.assertEqual(res.json()["filesize"], 10)

    def proxied(self, reachable: bool = True) -> None:
        """Fino a fine test: YTDLP_PROXY impostato, e il controllo TCP verso il proxy dà `reachable`."""
        for name, value in (("PROXY", PROXY_URL), ("_proxy_reachable", lambda: reachable)):
            patcher = mock.patch.object(worker, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_unreachable_proxy_fails_fast_without_running_yt_dlp(self):
        self.proxied(reachable=False)
        res = self.post()
        self.assertEqual((res.status_code, res.json()["detail"]), (502, "proxy_unreachable"))
        self.assertEqual(FakeYDL.calls, [])
        self.assertEqual(self.client.get("/health").json()["antibot"]["last"]["status"], "proxy_unreachable")

        probe = self.client.get("/antibot", headers=AUTH).json()
        self.assertEqual((probe["youtube"], probe["tried"], probe["proxy"]), ("proxy_unreachable", [], True))
        self.assertIn("host e porta", probe["hint"])

    def test_a_proxy_that_refuses_is_reported_and_does_not_rotate_clients(self):
        self.proxied()
        FakeYDL.script = {"default": PROXY_407}
        res = self.post()
        self.assertEqual((res.status_code, res.json()["detail"]), (502, "proxy_error"))
        self.assertEqual(FakeYDL.calls, ["default"])
        self.assertIn("utente e password", self.client.get("/antibot", headers=AUTH).json()["hint"])

    def test_requests_go_out_through_the_proxy(self):
        self.proxied()
        seen: list[str | None] = []
        original = FakeYDL.__init__

        def spy(ydl, opts):
            seen.append(opts.get("proxy"))
            original(ydl, opts)

        with mock.patch.object(FakeYDL, "__init__", spy):
            self.assertEqual(self.post().status_code, 200)
        self.assertEqual(seen, [PROXY_URL])

    def test_bot_check_names_the_levers_already_active(self):
        FakeYDL.script = {"default": BOT_CHECK, "tv": BOT_CHECK, "android_vr": BOT_CHECK}
        with mock.patch.object(worker, "COOKIEFILE", "/tmp/cookies.txt"):
            self.assertEqual(self.post().json()["detail"], "youtube_bot_check+cookies")
            self.assertIn("riesporta cookies.txt", self.client.get("/antibot", headers=AUTH).json()["hint"])

        self.proxied()
        self.assertEqual(self.post().json()["detail"], "youtube_bot_check+proxy")
        hint = self.client.get("/antibot", headers=AUTH).json()["hint"]
        self.assertIn("residenziale", hint)
        self.assertNotIn("cookies.txt", hint)
        with mock.patch.object(worker, "COOKIEFILE", "/tmp/cookies.txt"):
            self.assertEqual(self.post().json()["detail"], "youtube_bot_check+cookies+proxy")
        # Lo stato in /health resta il codice stabile: le leve sono già lì accanto (cookies, proxy).
        self.assertEqual(self.client.get("/health").json()["antibot"]["last"]["status"], "youtube_bot_check")


class ProxyTest(unittest.TestCase):
    """YTDLP_PROXY arriva da un campo web, nel formato che dà il fornitore: va letto e mai mostrato."""

    def test_formats_handed_out_by_providers_are_accepted(self):
        accepted = {
            "http://user:pw@proxy.example.com:8080": "http://user:pw@proxy.example.com:8080",
            "HTTP://user:pw@proxy.example.com:8080/": "http://user:pw@proxy.example.com:8080",
            "socks5://proxy.example.com:1080": "socks5://proxy.example.com:1080",
            "socks5h://user@[2001:db8::1]:1080": "socks5h://user@[2001:db8::1]:1080",
            "proxy.example.com:8080": "http://proxy.example.com:8080",
            "user:pw@proxy.example.com:8080": "http://user:pw@proxy.example.com:8080",
            "token:@proxy.example.com:8001": "http://token:@proxy.example.com:8001",
            "proxy.example.com:8080:user:pw": "http://user:pw@proxy.example.com:8080",
            "socks5://proxy.example.com:1080:user:pw": "socks5://user:pw@proxy.example.com:1080",
            "user:pw:proxy.example.com:8080": "http://user:pw@proxy.example.com:8080",
            "203.0.113.7:8080:user:pw": "http://user:pw@203.0.113.7:8080",
            '  "proxy.example.com:8080:user:pw"  ': "http://user:pw@proxy.example.com:8080",
            # Password con «@», «:», «/», «#»: codificata, così l'URL resta leggibile da yt-dlp.
            "proxy.example.com:8080:user:p@ss:word/1#x": "http://user:p%40ss%3Aword%2F1%23x@proxy.example.com:8080",
            "http://user:p@ss:word@proxy.example.com:8080": "http://user:p%40ss%3Aword@proxy.example.com:8080",
            # Già codificata in un URL: non viene codificata due volte.
            "http://user:p%40ss@proxy.example.com:8080": "http://user:p%40ss@proxy.example.com:8080",
            # Password di sole cifre: le due letture reggono, vince quella con un host vero.
            "user:12345:proxy.example.com:8080": "http://user:12345@proxy.example.com:8080",
            "proxy.example.com:8080:user:12345": "http://user:12345@proxy.example.com:8080",
        }
        for raw, expected in accepted.items():
            self.assertEqual(worker._normalize_proxy(raw), (expected, None), raw)
        self.assertEqual(worker._normalize_proxy("   "), ("", None))

    def test_unusable_values_are_refused_without_echoing_them(self):
        # Meglio nessun proxy che ogni richiesta fallita; il motivo va in /health, quindi niente valore.
        for raw in (
            "just-a-host",
            "a:b:c",
            "ftp://proxy.example.com:21",
            "http://proxy.example.com",
            "proxy.example.com:99999",
            "proxy.example.com:8080:s3cret-user",
            "s3cret-user:s3cret-pw@proxy.example.com",
        ):
            url, error = worker._normalize_proxy(raw)
            self.assertEqual(url, "", raw)
            self.assertTrue(error, raw)
            for leaked in ("s3cret", "proxy.example.com"):
                self.assertNotIn(leaked, error, raw)

    def test_a_pasted_list_uses_its_first_readable_proxy(self):
        listed = "proxy.example.com:8080:user:pw\r\nproxy.example.com:8081:user:pw\nproxy.example.com:8082:user:pw\n"
        self.assertEqual(worker._first_proxy(listed), ("http://user:pw@proxy.example.com:8080", None, 2))
        # Una riga d'intestazione non impedisce di trovare il proxy.
        self.assertEqual(
            worker._first_proxy("proxies:\n  socks5://proxy.example.com:1080\n"),
            ("socks5://proxy.example.com:1080", None, 1),
        )
        self.assertEqual(worker._first_proxy(' "proxy.example.com:8080" '), ("http://proxy.example.com:8080", None, 0))
        self.assertEqual(worker._first_proxy(""), ("", None, 0))
        url, error, ignored = worker._first_proxy("not-a-proxy\nstill:not")
        self.assertEqual((url, ignored), ("", 0))
        self.assertIn("formato non riconosciuto", error)

    def test_credentials_never_reach_the_logs(self):
        with mock.patch.object(worker, "PROXY", "http://user:s3cret@proxy.example.com:8080"):
            self.assertEqual(worker._base_opts()["proxy"], "http://user:s3cret@proxy.example.com:8080")
            text = worker._redact("ProxyError: cannot reach http://user:s3cret@proxy.example.com:8080 (s3cret)")
        self.assertEqual(text, "ProxyError: cannot reach [proxy] (***)")

        # Password con caratteri speciali: sparisce sia codificata sia in chiaro, e lo username lungo con lei.
        with mock.patch.object(worker, "PROXY", "http://customer-1234:p%40ss%3Aword@proxy.example.com:8080"):
            text = worker._redact("auth failed for customer-1234 with p@ss:word / p%40ss%3Aword")
        self.assertEqual(text, "auth failed for *** with *** / ***")

    def test_yt_dlp_itself_writes_nothing_raw_to_the_logs(self):
        # yt-dlp VERO contro un proxy spento: senza il logger muto stamperebbe "ERROR: …" su stderr.
        closed = socket.socket()
        closed.bind(("127.0.0.1", 0))
        port = closed.getsockname()[1]
        closed.close()
        stderr = io.StringIO()
        with mock.patch.object(worker, "PROXY", f"http://user:s3cret@127.0.0.1:{port}"):
            self.assertFalse(worker._proxy_reachable())
            with contextlib.redirect_stderr(stderr), self.assertRaises(yt_dlp.utils.DownloadError) as raised:
                with yt_dlp.YoutubeDL(worker._base_opts()) as ydl:
                    ydl.extract_info("https://www.youtube.com/watch?v=jNQXAC9IVRw", download=False, process=False)
        self.assertEqual(stderr.getvalue(), "")
        self.assertEqual(worker._classify_error(raised.exception), "proxy_error")

    def test_reachability_is_a_real_connection_to_the_proxy(self):
        with socket.socket() as listening:
            listening.bind(("127.0.0.1", 0))
            listening.listen()
            port = listening.getsockname()[1]
            with mock.patch.object(worker, "PROXY", f"socks5://user:pw@127.0.0.1:{port}"):
                self.assertTrue(worker._proxy_reachable())
        with mock.patch.object(worker, "PROXY", f"socks5://user:pw@127.0.0.1:{port}"):
            self.assertFalse(worker._proxy_reachable())

    def test_health_reports_the_proxy_without_host_or_credentials(self):
        client = TestClient(worker.app)
        self.assertEqual(
            client.get("/health").json()["antibot"]["proxy_info"], {"scheme": None, "error": None, "ignored": 0}
        )
        with mock.patch.object(worker, "PROXY", "socks5://user:s3cret@proxy.example.com:1080"):
            body = client.get("/health").text
        self.assertIn('"proxy":true', body)
        self.assertIn('"scheme":"socks5"', body)
        for leaked in ("s3cret", "proxy.example.com"):
            self.assertNotIn(leaked, body)

        # Valore illeggibile: nessun proxy in uso, e /health dice perché.
        with mock.patch.object(worker, "PROXY_ERROR", "formato non riconosciuto"):
            info = client.get("/health").json()["antibot"]
        self.assertEqual((info["proxy"], info["proxy_info"]["error"]), (False, "formato non riconosciuto"))


TAB = "\t"
SID = TAB.join([".youtube.com", "TRUE", "/", "TRUE", "2000000000", "SID", "s3cr3t-sid-value"])
HSID = "#HttpOnly_" + TAB.join([".youtube.com", "TRUE", "/", "TRUE", "2000000000", "HSID", "s3cr3t-hsid-value"])
EXPORTED = f"# Netscape HTTP Cookie File\n# exported by a browser extension\n\n{SID}\n{HSID}\n"


class CookiesTest(unittest.TestCase):
    """I cookie arrivano da un campo web (variabile o Secret File): devono caricarsi comunque."""

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="ytdlp-cookies-test-"))
        for name, value in {
            "COOKIES_RUNTIME_PATH": self.dir / "runtime" / "cookies.txt",
            "SECRET_COOKIES_PATH": str(self.dir / "missing.txt"),
            "COOKIES_FILE_ENV": "",
            "_COOKIES_INLINE": "",
        }.items():
            patcher = mock.patch.object(worker, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def names(self, text: str) -> list[str]:
        path = self.dir / "check.txt"
        path.write_text(text)
        jar = worker.YoutubeDLCookieJar(str(path))
        jar.load()
        return sorted(cookie.name for cookie in jar)

    def test_repairs_what_a_web_form_does_to_a_cookies_file(self):
        variants = {
            "as exported": EXPORTED,
            "windows line endings": EXPORTED.replace("\n", "\r\n"),
            "header missing": f"{SID}\n{HSID}\n",
            "tabs pasted as spaces": EXPORTED.replace(TAB, " "),
            "everything on one line": EXPORTED.replace(TAB, " ").replace("\n", " "),
        }
        for label, text in variants.items():
            normalized, skipped = worker._normalize_cookies(text)
            self.assertEqual(self.names(normalized), ["HSID", "SID"], label)
            self.assertEqual(skipped, 0, label)

    def test_an_empty_value_keeps_its_seven_fields(self):
        empty = TAB.join([".youtube.com", "TRUE", "/", "TRUE", "2000000000", "EMPTY", ""])
        normalized, skipped = worker._normalize_cookies(f"{SID}\n{empty.rstrip(TAB)}\n")
        self.assertEqual((self.names(normalized), skipped), (["EMPTY", "SID"], 0))

    def test_unreadable_lines_are_dropped_and_counted(self):
        normalized, skipped = worker._normalize_cookies(EXPORTED + "not a cookie line\n" + '{"json": true}\n')
        self.assertEqual(skipped, 2)
        self.assertNotIn("not a cookie", normalized)
        self.assertEqual(self.names(normalized), ["HSID", "SID"])

    def test_secret_file_is_copied_to_a_writable_path_and_reported_without_secrets(self):
        secret = self.dir / "cookies.txt"
        secret.write_text(EXPORTED.replace(TAB, " "))
        secret.chmod(0o400)
        with mock.patch.object(worker, "SECRET_COOKIES_PATH", str(secret)):
            path = worker._resolve_cookies()
        self.assertEqual(path, str(worker.COOKIES_RUNTIME_PATH))
        self.assertNotEqual(path, str(secret))
        self.assertEqual(self.names(Path(path).read_text()), ["HSID", "SID"])
        info = dict(worker.COOKIES_INFO)
        self.assertEqual(
            info, {"source": "secret-file", "count": 2, "youtube": True, "skipped": 0, "error": None}
        )
        with mock.patch.object(worker, "COOKIEFILE", path):
            health = TestClient(worker.app).get("/health").text
        self.assertIn('"cookies":true', health)
        self.assertNotIn("s3cr3t", health)

    def test_source_order_is_explicit_file_then_variable_then_secret_file(self):
        explicit, secret = self.dir / "explicit.txt", self.dir / "cookies.txt"
        explicit.write_text(EXPORTED)
        secret.write_text(EXPORTED)
        with mock.patch.object(worker, "SECRET_COOKIES_PATH", str(secret)):
            worker._resolve_cookies()
            self.assertEqual(worker.COOKIES_INFO["source"], "secret-file")
            with mock.patch.object(worker, "_COOKIES_INLINE", EXPORTED):
                worker._resolve_cookies()
                self.assertEqual(worker.COOKIES_INFO["source"], "env")
                with mock.patch.object(worker, "COOKIES_FILE_ENV", str(explicit)):
                    worker._resolve_cookies()
                    self.assertEqual(worker.COOKIES_INFO["source"], "file")

    def test_unusable_cookies_are_not_passed_to_yt_dlp(self):
        for text in ("just some text", '[{"domain": ".youtube.com", "name": "SID"}]'):
            with mock.patch.object(worker, "_COOKIES_INLINE", text):
                self.assertIsNone(worker._resolve_cookies(), text)
            self.assertEqual(worker.COOKIES_INFO["count"], 0)
            self.assertIn("nessun cookie valido", worker.COOKIES_INFO["error"])

    def test_no_cookies_configured(self):
        self.assertIsNone(worker._resolve_cookies())
        self.assertEqual(
            dict(worker.COOKIES_INFO),
            {"source": None, "count": 0, "youtube": False, "skipped": 0, "error": None},
        )


if __name__ == "__main__":
    unittest.main()

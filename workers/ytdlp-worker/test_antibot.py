# Test dell'anti-bot del worker: yt-dlp è sostituito da un finto che recita un copione per client
# (nessuna rete). Esegui dalla cartella del worker:
#   pip install -r requirements.txt httpx && python -m unittest -v test_antibot
import os
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

    def test_proxy_credentials_never_reach_the_logs(self):
        with mock.patch.object(worker, "PROXY", "http://user:s3cret@proxy.example.com:8080"):
            self.assertEqual(worker._base_opts()["proxy"], "http://user:s3cret@proxy.example.com:8080")
            text = worker._redact("ProxyError: cannot reach http://user:s3cret@proxy.example.com:8080 (s3cret)")
        self.assertNotIn("s3cret", text)


if __name__ == "__main__":
    unittest.main()

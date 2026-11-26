# Test di /chat: un finto server OpenAI-compatibile in locale (nessuna rete esterna).
# Esegui dalla cartella del worker:
#   pip install -r requirements.txt httpx && python -m unittest -v test_chat
import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

os.environ.update(
    WORKER_API_KEY="test-key",
    WORKER_MODE="extract",
    DOWNLOAD_DIR=tempfile.mkdtemp(prefix="ytdlp-worker-chat-"),
    YTDLP_PROXY="",
    YTDLP_WARP="",
)
os.environ.pop("YTDLP_SERVICE_KEY", None)

from fastapi.testclient import TestClient  # noqa: E402

import app as worker  # noqa: E402

AUTH = {"authorization": "Bearer test-key"}


class _Upstream(BaseHTTPRequestHandler):
    seen: list = []
    status = 200

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        _Upstream.seen.append({"path": self.path, "auth": self.headers.get("Authorization"), "body": body})
        out = (
            {"model": body["model"], "choices": [{"message": {"content": "pong"}}], "usage": {"total_tokens": 3}}
            if _Upstream.status == 200
            else {"error": "nope"}
        )
        raw = json.dumps(out).encode()
        self.send_response(_Upstream.status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *args):
        pass


class ChatTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), _Upstream)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}/v1"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        _Upstream.seen.clear()
        _Upstream.status = 200
        worker.CHAT_ENDPOINT_URL = self.url
        worker.CHAT_ENDPOINT_TOKEN = "upstream-secret"
        self.client = TestClient(worker.app)
        self.body = {"messages": [{"role": "user", "content": "ping"}], "temperature": 9, "max_tokens": 99999}

    def test_requires_worker_key(self):
        self.assertEqual(self.client.post("/chat", json=self.body).status_code, 401)
        bad = {"authorization": "Bearer wrong"}
        self.assertEqual(self.client.post("/chat", json=self.body, headers=bad).status_code, 401)
        self.assertEqual(_Upstream.seen, [])

    def test_second_key_rotation(self):
        old = worker.API_KEY_2
        try:
            worker.API_KEY_2 = ""
            k2 = {"authorization": "Bearer key-two"}
            self.assertEqual(self.client.post("/chat", json=self.body, headers=k2).status_code, 401)
            worker.API_KEY_2 = "key-two"
            self.assertEqual(self.client.post("/chat", json=self.body, headers=k2).status_code, 200)
            self.assertEqual(self.client.post("/chat", json=self.body, headers=AUTH).status_code, 200)
            self.assertEqual(
                self.client.post("/chat", json=self.body, headers={"authorization": "Bearer nope"}).status_code,
                401,
            )
        finally:
            worker.API_KEY_2 = old

    def test_proxies_and_clamps(self):
        r = self.client.post("/chat", json=self.body, headers=AUTH)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["reply"], "pong")
        sent = _Upstream.seen[0]
        self.assertEqual(sent["path"], "/v1/chat/completions")
        self.assertEqual(sent["auth"], "Bearer upstream-secret")
        self.assertEqual(sent["body"]["temperature"], 2.0)
        self.assertEqual(sent["body"]["max_tokens"], 8192)
        self.assertFalse(sent["body"]["stream"])

    def test_unconfigured_is_503(self):
        worker.CHAT_ENDPOINT_URL = ""
        r = self.client.post("/chat", json=self.body, headers=AUTH)
        self.assertEqual(r.status_code, 503)
        self.assertFalse(self.client.get("/health").json()["chat"])

    def test_bad_role_is_400(self):
        body = {"messages": [{"role": "tool", "content": "x"}]}
        self.assertEqual(self.client.post("/chat", json=body, headers=AUTH).status_code, 400)

    def test_upstream_error_is_502_without_leaking(self):
        _Upstream.status = 500
        r = self.client.post("/chat", json=self.body, headers=AUTH)
        self.assertEqual(r.status_code, 502)
        self.assertEqual(r.json()["detail"], "upstream_http_500")

    def test_unreachable_is_504(self):
        worker.CHAT_ENDPOINT_URL = "http://127.0.0.1:9/v1"
        r = self.client.post("/chat", json=self.body, headers=AUTH)
        self.assertEqual(r.status_code, 504)


if __name__ == "__main__":
    unittest.main()

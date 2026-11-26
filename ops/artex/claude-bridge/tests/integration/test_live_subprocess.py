# @polsia:user-owned — runtime integration test. Spawns `python -m bridge.main`
# (the actual production entry point: uvicorn listening on a socket, startup
# lifecycle, graceful shutdown) and drives it with a real HTTP client. This
# layer is between TestClient (in-process ASGI, no socket) and a full Docker
# compose run on a VPS. If this passes, the container will work too — the
# only missing wrap is Docker itself.
#
# Same double gate as test_live.py:
#   - ARTEX_BRIDGE_LIVE_TESTS=1
#   - `claude` CLI on PATH and logged in
from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx
import pytest

pytestmark = pytest.mark.integration

_LIVE = os.environ.get("ARTEX_BRIDGE_LIVE_TESTS") == "1"
_CLI = shutil.which("claude")
_requires_live = pytest.mark.skipif(
    not (_LIVE and _CLI),
    reason="set ARTEX_BRIDGE_LIVE_TESTS=1 and ensure `claude` CLI is on PATH + logged in",
)

MODEL = os.environ.get("ARTEX_BRIDGE_LIVE_MODEL", "claude-haiku-4-5")
PROJECT_ROOT = Path(__file__).resolve().parents[2]
SRC_PATH = PROJECT_ROOT / "src"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_for_health(port: int, timeout_s: float = 20.0) -> None:
    deadline = time.monotonic() + timeout_s
    last_err: Exception | None = None
    while time.monotonic() < deadline:
        try:
            r = httpx.get(f"http://127.0.0.1:{port}/health", timeout=2.0)
            if r.status_code == 200 and r.json().get("ok") is True:
                return
        except Exception as e:  # noqa: BLE001
            last_err = e
        time.sleep(0.25)
    raise RuntimeError(f"bridge did not come up on :{port} within {timeout_s}s: {last_err}")


@_requires_live
def test_subprocess_health_and_tool_use_roundtrip() -> None:
    port = _free_port()
    with tempfile.TemporaryDirectory() as data_dir:
        env = {
            **os.environ,
            "PYTHONPATH": str(SRC_PATH),
            "BRIDGE_PORT": str(port),
            "BRIDGE_HOST": "127.0.0.1",
            "BRIDGE_CACHE_PATH": str(Path(data_dir) / "cache.sqlite"),
            # Disable rate limiting so the test isn't fighting the floor.
            "BRIDGE_MAX_RPS": "0",
            "BRIDGE_MAX_CONCURRENCY": "0",
            "BRIDGE_LOG_LEVEL": "WARNING",
        }
        proc = subprocess.Popen(
            [sys.executable, "-m", "bridge.main"],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=str(PROJECT_ROOT),
        )
        try:
            _wait_for_health(port)

            # Health shape.
            h = httpx.get(f"http://127.0.0.1:{port}/health", timeout=5.0).json()
            assert h["ok"] is True
            assert h["service"] == "artex-claude-bridge"

            # Real tool_use roundtrip: planner picks http_get on the authorized host.
            res = httpx.post(
                f"http://127.0.0.1:{port}/v1/messages",
                headers={"x-api-key": "live-sub", "anthropic-version": "2023-06-01"},
                json={
                    "model": MODEL,
                    "max_tokens": 200,
                    "system": (
                        "You are a probe. When asked to fetch a URL, call "
                        "http_get. No prose; call the tool."
                    ),
                    "messages": [
                        {"role": "user", "content": "Fetch https://example.test/health"}
                    ],
                    "tools": [
                        {
                            "name": "http_get",
                            "description": "GET a URL",
                            "input_schema": {
                                "type": "object",
                                "properties": {"url": {"type": "string"}},
                                "required": ["url"],
                            },
                        }
                    ],
                },
                timeout=60.0,
            )
            assert res.status_code == 200, res.text
            body = res.json()
            assert body["type"] == "message"
            assert body["stop_reason"] == "tool_use"
            tool_uses = [b for b in body["content"] if b.get("type") == "tool_use"]
            assert tool_uses, body
            assert tool_uses[0]["name"] == "http_get"
            assert "example.test" in tool_uses[0]["input"].get("url", "")
            # Usage must be the honest floor from the prompt size.
            assert body["usage"]["input_tokens"] >= 30
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)

#!/usr/bin/env python3
# ops/artex/llm-shim/proxy.py — an OpenAI-compatible reliability proxy for ARTEX.
#
# Two jobs:
#   1. Strip `reasoning_content` (and `reasoning`) from chat messages before
#      they reach the upstream — reasoning models (DeepSeek-R1 / V4.1-Flash on
#      vLLM, etc.) return that field and ARTEX echoes it back, which strict
#      OpenAI-schema upstreams reject with HTTP 400.
#   2. Reliability failover + retry across several OpenAI-compatible backends.
#
# FAILOVER POLICY — read this before changing it:
#   Failover fires ONLY on transient infrastructure failures: connection
#   errors, timeouts, and HTTP 408/409/425/429/5xx (incl. 529 "overloaded").
#   It DOES NOT fire on a safety refusal. A refusal comes back as HTTP 200
#   (or a 4xx that is not in the retry set) and is relayed to ARTEX unchanged.
#   We never auto-reroute a declined request to a less-restricted model — that
#   would be circumventing the provider's safety decision, not reliability.
#   Config errors (400/401/403/404) are also passed straight through so they
#   stay visible instead of being masked by a silent fallback.
#
# Config: /app/backends.json (mounted read-only). See backends.example.json.
#   { "backends": [ {name,url,model,auth,headers?}, ... ],
#     "max_retries_per_backend": 2, "backoff_base_seconds": 0.5,
#     "retry_statuses": [408,409,425,429,500,502,503,504,529] }
# Each backend's `model` OVERRIDES the model ARTEX sends, and its `auth`
# replaces the inbound Authorization header — so real keys live only here, and
# ARTEX's own OPENAI_API_KEY can be a dummy placeholder.
#
# ARTEX setup (.env): ARTEX_LLM_PROVIDER=openai,
#   ARTEX_LLM_BASE_URL=http://llm-shim:8080/v1, OPENAI_API_KEY=dummy

import json
import os
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CONFIG_PATH = os.environ.get("LLM_BACKENDS_FILE", "/app/backends.json")
PORT = int(os.environ.get("LLM_SHIM_PORT", "8080"))

HOP = {
    "host", "content-length", "connection", "keep-alive", "proxy-authenticate",
    "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade",
    "accept-encoding", "authorization",
}


def load_config():
    with open(CONFIG_PATH, encoding="utf-8") as f:
        cfg = json.load(f)
    backends = cfg.get("backends") or []
    if not backends:
        raise SystemExit(f"llm-shim: no backends in {CONFIG_PATH}")
    for b in backends:
        for k in ("name", "url", "model", "auth"):
            if not b.get(k):
                raise SystemExit(f"llm-shim: backend missing '{k}': {b.get('name', b)}")
    cfg["backends"] = backends
    cfg.setdefault("max_retries_per_backend", 2)
    cfg.setdefault("backoff_base_seconds", 0.5)
    cfg.setdefault(
        "retry_statuses", [408, 409, 425, 429, 500, 502, 503, 504, 529]
    )
    return cfg


CFG = load_config()


def strip_reasoning(obj):
    """Remove reasoning_content/reasoning from each message in messages[]."""
    if isinstance(obj, dict):
        msgs = obj.get("messages")
        if isinstance(msgs, list):
            for m in msgs:
                if isinstance(m, dict):
                    m.pop("reasoning_content", None)
                    m.pop("reasoning", None)
    return obj


def is_chat_completions(path):
    return path.rstrip("/").endswith("/chat/completions")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # ---- helpers ----------------------------------------------------------
    def _error(self, status, message):
        body = json.dumps({"error": {"message": f"llm-shim: {message}"}}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.close_connection = True
        self.end_headers()
        self.wfile.write(body)

    def _relay(self, resp):
        """Stream an upstream response straight back (read-until-EOF framing)."""
        self.send_response(resp.status)
        for k, v in resp.headers.items():
            if k.lower() in HOP or k.lower() in ("content-length", "transfer-encoding"):
                continue
            self.send_header(k, v)
        self.send_header("Connection", "close")
        self.close_connection = True
        self.end_headers()
        while True:
            chunk = resp.read(8192)
            if not chunk:
                break
            self.wfile.write(chunk)

    def _open(self, backend, body, base_headers):
        """One attempt at one backend. Returns (resp, None) or (None, reason)."""
        headers = dict(base_headers)
        headers["Authorization"] = backend["auth"]
        for k, v in (backend.get("headers") or {}).items():
            headers[k] = v
        req = urllib.request.Request(
            backend["url"], data=body or None, method="POST", headers=headers
        )
        try:
            resp = urllib.request.urlopen(req, timeout=600)
            return resp, None
        except urllib.error.HTTPError as e:
            return e, None  # caller inspects e.status (it is a response too)
        except Exception as e:  # noqa: BLE001 — conn error / timeout
            return None, repr(e)

    # ---- chat completions with failover ----------------------------------
    def _chat(self, body, base_headers):
        try:
            data = strip_reasoning(json.loads(body))
        except (ValueError, TypeError):
            data = None

        retry_statuses = set(CFG["retry_statuses"])
        tries = CFG["max_retries_per_backend"]
        base = CFG["backoff_base_seconds"]
        attempts_log = []

        for backend in CFG["backends"]:
            if data is not None:
                out = dict(data)
                out["model"] = backend["model"]  # per-backend model override
                sendbody = json.dumps(out).encode()
            else:
                sendbody = body

            for attempt in range(tries + 1):
                resp, conn_err = self._open(backend, sendbody, base_headers)
                if conn_err is not None:
                    attempts_log.append(f"{backend['name']}: {conn_err}")
                    if attempt < tries:
                        time.sleep(base * (2 ** attempt))
                        continue
                    break  # next backend
                status = resp.status
                if status in retry_statuses:
                    attempts_log.append(f"{backend['name']}: HTTP {status}")
                    resp.close()
                    if attempt < tries:
                        time.sleep(base * (2 ** attempt))
                        continue
                    break  # transient after retries → next backend
                # Any other status (2xx incl. refusals, or 4xx config errors):
                # this is the authoritative answer. Relay it, no failover.
                self._relay(resp)
                return

        # Every backend failed transiently.
        self._error(503, "all backends unavailable; tried -> " + "; ".join(attempts_log))

    # ---- passthrough for non-chat paths (e.g. /v1/models) ----------------
    def _passthrough(self, method, body, base_headers):
        backend = CFG["backends"][0]
        # Reuse the backend origin but keep the caller's path.
        from urllib.parse import urlsplit, urlunsplit
        parts = urlsplit(backend["url"])
        url = urlunsplit((parts.scheme, parts.netloc, self.path, "", ""))
        headers = dict(base_headers)
        headers["Authorization"] = backend["auth"]
        for k, v in (backend.get("headers") or {}).items():
            headers[k] = v
        req = urllib.request.Request(url, data=body or None, method=method, headers=headers)
        try:
            resp = urllib.request.urlopen(req, timeout=120)
        except urllib.error.HTTPError as e:
            resp = e
        except Exception as e:  # noqa: BLE001
            self._error(502, f"passthrough: {e}")
            return
        self._relay(resp)

    def _handle(self, method):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        base_headers = {
            k: v for k, v in self.headers.items() if k.lower() not in HOP
        }
        if method == "POST" and is_chat_completions(self.path):
            self._chat(body, base_headers)
        else:
            self._passthrough(method, body, base_headers)

    def do_POST(self):
        self._handle("POST")

    def do_GET(self):
        self._handle("GET")

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    names = ", ".join(f"{b['name']}({b['model']})" for b in CFG["backends"])
    print(
        f"llm-shim: :{PORT} | strip reasoning_content | "
        f"transient-only failover across: {names}",
        flush=True,
    )
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()

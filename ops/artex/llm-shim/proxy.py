#!/usr/bin/env python3
# ops/artex/llm-shim/proxy.py — a tiny OpenAI-compatible reverse proxy that
# strips `reasoning_content` (and `reasoning`) from chat messages before they
# reach the upstream LLM server.
#
# Why: reasoning models (DeepSeek-R1 / V4.1-Flash served by vLLM with a
# reasoning parser) return a separate `reasoning_content` field. ARTEX echoes
# whole prior assistant turns back on the next request, and vLLM's OpenAI
# INPUT schema rejects `reasoning_content` -> HTTP 400 from turn ~3 on. This
# shim sits between ARTEX and the LLM and removes the offending field from the
# request body. Responses are relayed untouched (streaming included), so the
# model keeps reasoning; only the wire format ARTEX sends back is cleaned.
#
# Config (env):
#   LLM_UPSTREAM_ORIGIN  scheme://host[:port] of the real LLM server, no path
#                        (e.g. https://my-gpu-box.example.com). REQUIRED.
#   LLM_SHIM_PORT        listen port inside the container (default 8080).
#
# Point ARTEX at the shim by setting, in .env:
#   ARTEX_LLM_BASE_URL=http://llm-shim:8080/v1   (keep the same /v1 suffix the
#                                                  old base URL had)
#   LLM_UPSTREAM_ORIGIN=https://my-gpu-box.example.com  (origin of that old URL)

import json
import os
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = os.environ.get("LLM_UPSTREAM_ORIGIN", "").rstrip("/")
PORT = int(os.environ.get("LLM_SHIM_PORT", "8080"))

if not UPSTREAM:
    raise SystemExit(
        "llm-shim: LLM_UPSTREAM_ORIGIN is required (scheme://host[:port] of the "
        "real LLM endpoint, no path). Set it in .env, e.g. "
        "LLM_UPSTREAM_ORIGIN=https://my-gpu-box.example.com"
    )

# Hop-by-hop headers (RFC 7230) + encoding/length we recompute. Never forwarded.
HOP = {
    "host", "content-length", "connection", "keep-alive", "proxy-authenticate",
    "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade",
    "accept-encoding",
}


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


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _relay(self, method):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""

        ctype = self.headers.get("Content-Type", "")
        if body and "application/json" in ctype:
            try:
                body = json.dumps(strip_reasoning(json.loads(body))).encode()
            except (ValueError, TypeError):
                pass  # not JSON we understand — forward untouched

        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP}
        req = urllib.request.Request(
            UPSTREAM + self.path, data=body or None, method=method, headers=headers
        )
        try:
            resp = urllib.request.urlopen(req, timeout=600)
        except urllib.error.HTTPError as e:
            resp = e  # relay the upstream's own error status/body verbatim
        except Exception as e:  # noqa: BLE001 — surface any dial/timeout failure
            msg = json.dumps({"error": {"message": f"llm-shim: {e}"}}).encode()
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(msg)))
            self.send_header("Connection", "close")
            self.close_connection = True
            self.end_headers()
            self.wfile.write(msg)
            return

        self.send_response(resp.status)
        for k, v in resp.headers.items():
            if k.lower() in HOP or k.lower() in ("content-length", "transfer-encoding"):
                continue
            self.send_header(k, v)
        # Read-until-EOF framing: works for both buffered and streaming (SSE)
        # responses without us having to understand chunked encoding.
        self.send_header("Connection", "close")
        self.close_connection = True
        self.end_headers()
        while True:
            chunk = resp.read(8192)
            if not chunk:
                break
            self.wfile.write(chunk)

    def do_POST(self):
        self._relay("POST")

    def do_GET(self):
        self._relay("GET")

    def log_message(self, *a):
        pass  # quiet; ARTEX and vLLM log their own traffic


if __name__ == "__main__":
    print(f"llm-shim: :{PORT} -> {UPSTREAM} (stripping reasoning_content)", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()

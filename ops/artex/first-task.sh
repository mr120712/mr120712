#!/usr/bin/env bash
# ops/artex/first-task.sh — drive ARTEX from the VPS to create company + scope
# + a tiny probe task, all via the REST API. No UI, no gateway involved.
#
# ARTEX binds its API on 127.0.0.1:8787 on the host (see docker-compose.yml
# ports:), so we just hit it with Python's urllib from the VPS. This avoids
# the fragile `docker compose exec … sh -lc "<quoted JSON>"` dance.
#
# Reads ARTEX_SESSION_PASSWORD + ARTEX_TARGET_HOST from ./.env.
# Run from ~/artex:
#   ./first-task.sh
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "ERROR: ./.env not found; run from ~/artex." >&2; exit 2; }

exec python3 - <<'PY'
import json, os, pathlib, sys, urllib.request, urllib.error

def load_env(path=".env"):
    out = {}
    for line in pathlib.Path(path).read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        v = v.strip()
        # Strip ONE enclosing pair of quotes if present.
        if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
            v = v[1:-1]
        out[k.strip()] = v
    return out

env = load_env()
pw = env.get("ARTEX_SESSION_PASSWORD")
target = env.get("ARTEX_TARGET_HOST")
if not pw:
    sys.exit("ERROR: ARTEX_SESSION_PASSWORD missing in .env")
if not target:
    sys.exit("ERROR: ARTEX_TARGET_HOST missing in .env")

BASE = "http://127.0.0.1:8787"

def req(method, path, body=None, token=None):
    data = None if body is None else json.dumps(body).encode()
    headers = {"content-type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    r = urllib.request.Request(f"{BASE}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            body = json.loads(raw)
        except Exception:
            body = {"error": raw}
        return e.code, body

def say(msg):
    print(f"\033[1;34m[first-task]\033[0m {msg}", flush=True)

def die(msg):
    print(f"\033[1;31m[first-task]\033[0m {msg}", file=sys.stderr, flush=True)
    sys.exit(1)

# 1. Login — fixed username "ARTEX", password from .env.
say("Logging in to ARTEX…")
st, body = req("POST", "/api/auth/login", {"username": "ARTEX", "password": pw})
if st != 200 or not body.get("token"):
    die(f"login failed: HTTP {st} {body}")
jwt = body["token"]
say(f"Got session token ({len(jwt)} chars).")

# 2. Company with a domain-scope rule. ARTEX accepts kinds:
#    domain | ip | cidr | icp | keyword. Deny patterns from scope.json are
#    enforced by the egress layer regardless, so the API-level scope only
#    lists what's allowed.
say(f"Creating Company 'Solco staging preview' with scope domain={target}…")
st, body = req("POST", "/api/companies", {
    "name": "Solco staging preview",
    "logo": "",
    "scope": [{"kind": "domain", "value": target}],
}, token=jwt)
if st == 409:
    die("Company name already exists — delete it from the UI and re-run.")
if st != 201 or not body.get("id"):
    die(f"company create failed: HTTP {st} {body}")
company_id = body["id"]
say(f"Company id={company_id}, scope_added={body.get('scope_added')}.")

# 3. Task: single bounded probe.
say("Creating Task…")
goal = (
    "First pass only. Fetch the home page of the authorized target over HTTPS "
    "and report: HTTP status, final URL after any redirect, the Server and "
    "X-Powered-By headers, the page <title>, and a one-line description of "
    "what the app looks like. Do NOT follow outbound links, do NOT scan "
    "subpaths, do NOT probe forms. Stop after one GET."
)
st, body = req("POST", "/api/tasks", {
    "name": "First probe",
    "description": "First probe — fetch home, report status + title + headers",
    "goal": goal,
    "company_ids": [int(company_id)],
    "timeout_seconds": 600,
    "plan_heartbeat_seconds": 600,
    "seed_first_intent": True,
}, token=jwt)
if st not in (200, 201):
    die(f"task create failed: HTTP {st} {body}")
task_id = body.get("id") or body.get("task", {}).get("id") or ""
if not task_id:
    die(f"task create returned no id: {body}")
say(f"Task id={task_id}. The planner's first round should fire within ~5s.")

print("")
print("------------------------------------------------------------")
print(f"Task #{task_id} created for company #{company_id}.")
print("Tail the stack:")
print('  docker compose logs -f artex         | grep -E "task|planner|intent|worker" | grep -v "^time="')
print('  docker compose logs -f claude-bridge | grep -E "POST /v1/messages|rate_limit"')
print("------------------------------------------------------------")
PY

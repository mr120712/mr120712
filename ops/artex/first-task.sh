#!/usr/bin/env bash
# ops/artex/first-task.sh — drive ARTEX from the VPS to create company + scope
# + a tiny probe task, all via the REST API. No UI, no gateway involved.
#
# Reads ARTEX_SESSION_PASSWORD + ARTEX_TARGET_HOST from ./.env, logs into
# ARTEX directly on the compose network, creates a Company with a domain scope
# rule, creates one Task with a bounded goal, prints the task id and a tail
# command. Idempotent on the Company name: if it already exists you get 409
# and the script reuses it on a retry? — no, it fails loud. Delete it from
# the UI first if you want to re-run.
#
# Run from ~/artex on the VPS:
#   ./first-task.sh
set -euo pipefail

cd "$(dirname "$0")"
[ -f .env ] || { echo "ERROR: ./.env not found; run from ~/artex." >&2; exit 2; }

# Load only the two keys we need; keep the rest of .env out of our shell.
ARTEX_SESSION_PASSWORD="$(grep -E '^ARTEX_SESSION_PASSWORD=' .env | cut -d= -f2- | tr -d '"'"'"'')"
ARTEX_TARGET_HOST="$(grep -E '^ARTEX_TARGET_HOST=' .env | cut -d= -f2- | tr -d '"'"'"'')"

[ -n "${ARTEX_SESSION_PASSWORD:-}" ] || { echo "ERROR: ARTEX_SESSION_PASSWORD missing in .env"; exit 2; }
[ -n "${ARTEX_TARGET_HOST:-}" ] || { echo "ERROR: ARTEX_TARGET_HOST missing in .env"; exit 2; }

say() { printf '\033[1;34m[first-task]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[first-task]\033[0m %s\n' "$*" >&2; exit 1; }

# Everything speaks to ARTEX via `docker compose exec artex curl` so we land
# on localhost:8787 inside the artex container — no gateway, no TLS, no
# scope on the network path.
artex_curl() {
  local method="$1" path="$2" body="${3:-}" token_hdr=""
  [ -n "${JWT:-}" ] && token_hdr="-H \"Authorization: Bearer ${JWT}\""
  if [ -n "$body" ]; then
    docker compose exec -T artex sh -lc "
      curl -sS -X ${method} \
        -H 'content-type: application/json' \
        ${token_hdr} \
        -d '${body//\'/\'\\\'\'}' \
        http://127.0.0.1:8787${path}
    "
  else
    docker compose exec -T artex sh -lc "
      curl -sS -X ${method} \
        ${token_hdr} \
        http://127.0.0.1:8787${path}
    "
  fi
}

# 1) Login — ARTEX fixed username is literally the string "ARTEX".
say "Logging in to ARTEX…"
LOGIN_BODY="$(printf '{"username":"ARTEX","password":%s}' \
  "$(printf '%s' "$ARTEX_SESSION_PASSWORD" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')")"

LOGIN_RES="$(artex_curl POST /api/auth/login "$LOGIN_BODY")"
JWT="$(printf '%s' "$LOGIN_RES" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); print(d.get("token",""))')"
[ -n "$JWT" ] || die "login failed: $LOGIN_RES"
say "Got session token (${#JWT} chars)."

# 2) Company with a single domain-scope rule.
#    ARTEX's scope API supports kinds: domain, ip, cidr, icp, keyword. We pick
#    'domain' for the staging host. Deny patterns from scope.json are enforced
#    by the egress layer (ARTEX won't let the agent touch solcomusic.online /
#    *.hf.space / *.vercel.app regardless), so the API-level scope only lists
#    what's allowed.
say "Creating Company 'Solco staging preview' with scope domain=${ARTEX_TARGET_HOST}…"
COMPANY_BODY=$(python3 -c '
import json, os
print(json.dumps({
  "name": "Solco staging preview",
  "logo": "",
  "scope": [
    {"kind": "domain", "value": os.environ["ARTEX_TARGET_HOST"]}
  ]
}))
' ARTEX_TARGET_HOST="$ARTEX_TARGET_HOST")

COMPANY_RES="$(artex_curl POST /api/companies "$COMPANY_BODY")"
COMPANY_ID="$(printf '%s' "$COMPANY_RES" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); print(d.get("id",""))')"
if [ -z "$COMPANY_ID" ]; then
  echo "$COMPANY_RES"
  die "company create failed (above). If the name is taken, delete it from the UI and retry."
fi
say "Company id=${COMPANY_ID}."

# 3) Task: bounded single-GET probe, planner heartbeat long enough that we
#    reach completion in one round.
say "Creating Task…"
TASK_BODY=$(python3 -c '
import json, os
print(json.dumps({
  "name": "First probe",
  "description": "First probe — fetch home, report status + title + headers",
  "goal": (
    "First pass only. Fetch the home page of the authorized target over HTTPS "
    "and report: HTTP status, final URL after any redirect, the Server and "
    "X-Powered-By headers, the page <title>, and a one-line description of "
    "what the app looks like. Do NOT follow outbound links, do NOT scan "
    "subpaths, do NOT probe forms. Stop after one GET."
  ),
  "company_ids": [int(os.environ["COMPANY_ID"])],
  "timeout_seconds": 600,
  "plan_heartbeat_seconds": 600,
  "seed_first_intent": True
}))
' COMPANY_ID="$COMPANY_ID")

TASK_RES="$(artex_curl POST /api/tasks "$TASK_BODY")"
TASK_ID="$(printf '%s' "$TASK_RES" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); print(d.get("id") or d.get("task",{}).get("id") or "")')"
if [ -z "$TASK_ID" ]; then
  echo "$TASK_RES"
  die "task create failed (above)."
fi
say "Task id=${TASK_ID}. The planner's first round should fire within ~5s."

cat <<MSG

------------------------------------------------------------
Task #${TASK_ID} created for company #${COMPANY_ID}.
View it in the UI:  (your ARTEX host) /function/tasks/${TASK_ID}
Watch it on the CLI:
  docker compose logs -f artex         | grep -E "task|planner|intent|worker" | grep -v "^time="
  docker compose logs -f claude-bridge | grep -E "POST /v1/messages|rate_limit"
------------------------------------------------------------
MSG

#!/usr/bin/env bash
# ops/artex/bootstrap.sh — set up the ARTEX stack on a VPS you control.
#
# What it does:
#   1. Verifies the host looks like the VPS (not a CI container, not your laptop
#      via SSH into something weird). Asks before anything invasive.
#   2. Installs Docker Engine if it's missing (Ubuntu/Debian).
#   3. Pulls the ARTEX source at a pinned tag into ./artex-src.
#   4. Prompts for the staging host, LLM key, and Postgres password; writes
#      .env from .env.example.
#   5. Renders scope.json from scope.json.template.
#   6. Starts the stack.
#
# Idempotent: re-running it refreshes .env/scope.json prompts and `up -d`s.
# Pass --rescope to update only the staging host and rebuild scope.json.

set -euo pipefail

ARTEX_REPO="https://github.com/BaaRai/ARTEX.git"
# Which revision to build. By default the script auto-discovers the latest
# release tag; set ARTEX_REF=main for the bleeding edge, or ARTEX_REF=vX.Y.Z
# to pin a specific release.
ARTEX_REF="${ARTEX_REF:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

say()  { printf '\033[1;34m[artex]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[artex]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[artex]\033[0m %s\n' "$*" >&2; exit 1; }
prompt() {
  local label="$1" default="${2:-}" value=""
  if [ -n "$default" ]; then
    read -r -p "$label [$default]: " value || true
    printf '%s' "${value:-$default}"
  else
    read -r -p "$label: " value || true
    printf '%s' "$value"
  fi
}

[ "$(id -u)" = "0" ] || warn "Not root. The script will sudo for Docker install."

# ---- 1. sanity: this looks like a VPS ---------------------------------------
if [ ! -f /etc/os-release ] || ! grep -qiE "ubuntu|debian" /etc/os-release; then
  die "This bootstrap targets Ubuntu/Debian. On another OS, install Docker yourself and run 'docker compose up -d --build'."
fi
# Sanity: refuse to run inside the Solco repo checkout (the current directory
# is a git repo whose origin is this project). Catches accidental runs in a
# Claude/Codex sandbox or from a dev's own laptop clone. On the VPS, the
# bootstrap lives in ~/artex which is not a git repo, so this is a no-op.
if [ -d .git ] && git remote get-url origin 2>/dev/null | grep -qE 'mr120712/mr120712(\.git)?$'; then
  die "Looks like you're inside the Solco repo checkout, not the VPS's ~/artex. Run this on the VPS."
fi

# ---- 2. Docker --------------------------------------------------------------
if ! command -v docker >/dev/null; then
  say "Installing Docker Engine…"
  sudo apt-get update -y
  sudo apt-get install -y ca-certificates curl gnupg
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/$(. /etc/os-release && echo "$ID")/gpg | \
    sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/$(. /etc/os-release && echo "$ID") \
$(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
    sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  sudo usermod -aG docker "$USER" || true
  warn "You may need to log out and back in for the docker group to apply."
else
  say "Docker already present: $(docker --version)"
fi

# ---- 3. ARTEX source --------------------------------------------------------
# Resolve $ARTEX_REF: empty = the latest release tag by semver (vX.Y.Z); 'main'
# is allowed as an explicit opt-in to post-release fixes; otherwise honour the
# literal ref the operator passed.
if [ -z "$ARTEX_REF" ]; then
  say "Discovering the latest ARTEX release tag…"
  ARTEX_REF=$(git ls-remote --tags --refs "$ARTEX_REPO" \
    | awk -F/ '{print $NF}' \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
    | sort -V | tail -1)
  [ -n "$ARTEX_REF" ] || die "Could not resolve the latest ARTEX tag. Pass ARTEX_REF=vX.Y.Z or ARTEX_REF=main."
  say "Using $ARTEX_REF."
else
  say "Using the ref you asked for: $ARTEX_REF."
  if [ "$ARTEX_REF" = "main" ]; then
    warn "ARTEX_REF=main picks up post-release commits without a signed tag. Fine for staging, less so for a long-lived VPS."
  fi
fi

if [ ! -d artex-src/.git ]; then
  say "Cloning ARTEX at $ARTEX_REF…"
  git clone --depth 1 --branch "$ARTEX_REF" "$ARTEX_REPO" artex-src
else
  current=$(git -C artex-src rev-parse --abbrev-ref HEAD 2>/dev/null)
  if [ "$current" = "HEAD" ]; then
    current=$(git -C artex-src describe --tags --exact-match 2>/dev/null || echo unknown)
  fi
  if [ "$current" != "$ARTEX_REF" ]; then
    say "artex-src/ is on '$current'; switching to '$ARTEX_REF'."
    (cd artex-src && git fetch --depth 1 origin "$ARTEX_REF" \
       && git checkout -q FETCH_HEAD)
  else
    say "artex-src/ is already on '$ARTEX_REF'."
  fi
fi

# ---- 4. .env ----------------------------------------------------------------
RESCOPE_ONLY=0
if [ "${1:-}" = "--rescope" ]; then RESCOPE_ONLY=1; fi

if [ "$RESCOPE_ONLY" = 0 ]; then
  if [ ! -f .env ]; then cp .env.example .env; fi

  say "Setting up .env. Press Enter to keep the current value."
  . ./.env

  NEW_TARGET=$(prompt "Staging host (e.g. solco-git-....vercel.app)" "${ARTEX_TARGET_HOST:-}")
  [ -n "$NEW_TARGET" ] || die "ARTEX_TARGET_HOST is required."
  case "$NEW_TARGET" in
    http*|*://*) die "Host only, no scheme. Example: solco-git-foo.vercel.app" ;;
  esac
  case "$NEW_TARGET" in
    solcomusic.online|www.solcomusic.online) die "That's production. Pick a staging preview host." ;;
  esac

  # ARTEX's internal Postgres: never exposed on the host, never seen by a human.
  # Auto-generate a URL-safe password so the compose file's inline
  # ARTEX_PG_DSN never hits a / ? % @ : # or space.
  if [ -z "${POSTGRES_PASSWORD:-}" ] || [ "${POSTGRES_PASSWORD}" = "change-me-please" ]; then
    NEW_PG="$(openssl rand -base64 48 | tr -d '/+=' | head -c 40)"
    say "Generated a random Postgres password (internal to the ARTEX stack; never leaves the VPS)."
  else
    NEW_PG="$POSTGRES_PASSWORD"
  fi

  NEW_LLM_PROVIDER=$(prompt "LLM provider (anthropic/openai)" "${ARTEX_LLM_PROVIDER:-anthropic}")
  case "$NEW_LLM_PROVIDER" in
    anthropic)
      NEW_KEY=$(prompt "ANTHROPIC_API_KEY (sk-ant-...)" "${ANTHROPIC_API_KEY:-}")
      NEW_MODEL=$(prompt "ARTEX_LLM_MODEL" "${ARTEX_LLM_MODEL:-claude-opus-4-7}")
      KEY_LINE="ANTHROPIC_API_KEY=$NEW_KEY"
      OTHER_KEY_LINE="OPENAI_API_KEY="
      ;;
    openai)
      NEW_KEY=$(prompt "OPENAI_API_KEY (sk-...)" "${OPENAI_API_KEY:-}")
      NEW_MODEL=$(prompt "ARTEX_LLM_MODEL" "${ARTEX_LLM_MODEL:-gpt-5}")
      KEY_LINE="OPENAI_API_KEY=$NEW_KEY"
      OTHER_KEY_LINE="ANTHROPIC_API_KEY="
      ;;
    *) die "Unknown provider '$NEW_LLM_PROVIDER'. Use 'anthropic' or 'openai'." ;;
  esac
  [ -n "$NEW_KEY" ] || die "LLM key is required."

  # Rewrite the relevant lines of .env, leaving comments alone.
  tmp=$(mktemp)
  while IFS= read -r line; do
    case "$line" in
      ARTEX_TARGET_HOST=*)      echo "ARTEX_TARGET_HOST=$NEW_TARGET" ;;
      POSTGRES_PASSWORD=*)      echo "POSTGRES_PASSWORD=$NEW_PG" ;;
      ARTEX_LLM_PROVIDER=*)     echo "ARTEX_LLM_PROVIDER=$NEW_LLM_PROVIDER" ;;
      ARTEX_LLM_MODEL=*)        echo "ARTEX_LLM_MODEL=$NEW_MODEL" ;;
      ANTHROPIC_API_KEY=*|"# ANTHROPIC_API_KEY="*)
        [ "$NEW_LLM_PROVIDER" = anthropic ] && echo "$KEY_LINE" || echo "$OTHER_KEY_LINE" ;;
      OPENAI_API_KEY=*|"# OPENAI_API_KEY="*)
        [ "$NEW_LLM_PROVIDER" = openai ] && echo "$KEY_LINE" || echo "$OTHER_KEY_LINE" ;;
      *) echo "$line" ;;
    esac
  done < .env > "$tmp" && mv "$tmp" .env
  chmod 600 .env
else
  . ./.env
  NEW_TARGET=$(prompt "New staging host" "$ARTEX_TARGET_HOST")
  case "$NEW_TARGET" in
    http*|*://*) die "Host only, no scheme." ;;
    solcomusic.online|www.solcomusic.online) die "That's production." ;;
  esac
  sed -i "s|^ARTEX_TARGET_HOST=.*|ARTEX_TARGET_HOST=$NEW_TARGET|" .env
fi

# ---- 5. scope.json ----------------------------------------------------------
. ./.env
say "Rendering scope.json for host: $ARTEX_TARGET_HOST"
sed "s|\${ARTEX_TARGET_HOST}|$ARTEX_TARGET_HOST|g" scope.json.template > scope.json

# ---- 6. config.json ---------------------------------------------------------
# ARTEX v0.7.0's PostgresDSN() reads only ARTEX_PG_DSN from env (component env
# var support landed post-release). Write a config.json so ARTEX finds the DB
# regardless of which env var names the running version actually reads.
# Python's json module escapes the password safely even when it has special
# characters (quotes, backslashes, newlines) — the bootstrap generates a
# URL-safe password by default, but this way nothing breaks either way.
say "Rendering config.json (database section)."
POSTGRES_USER="$POSTGRES_USER" \
POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
POSTGRES_DB="$POSTGRES_DB" \
python3 -c '
import os, json
print(json.dumps({
  "_comment": "Generated by ops/artex/bootstrap.sh. Do not hand-edit; re-run bootstrap to regenerate.",
  "database": {
    "host": "postgres",
    "port": 5432,
    "user": os.environ["POSTGRES_USER"],
    "password": os.environ["POSTGRES_PASSWORD"],
    "dbname": os.environ["POSTGRES_DB"],
    "sslmode": "disable",
  }
}, indent=2))
' > config.json
chmod 600 config.json

# ---- 6. go ------------------------------------------------------------------
say "Starting the stack…"
docker compose up -d --build

PUBLIC_HOST="${ARTEX_PUBLIC_HOST:-artex.solcomusic.online}"

cat <<EOF

[artex] Ready.
       UI (private):   http://127.0.0.1:8787  (SSH tunnel; see tunnel.md)
       API (public):   https://${PUBLIC_HOST}
                       — ARTEX's own JWT auth is the gate (see docs).
                       — First visit: hit this URL from a browser to confirm
                         Caddy obtained the Let's Encrypt cert. Should land on
                         the ARTEX setup/login page.
       Target:         $ARTEX_TARGET_HOST
       Logs:           docker compose logs -f artex
                       docker compose logs -f caddy      # TLS + proxy
       Setup token (first visit only):
                       docker compose logs artex | grep "Setup token"

[artex] After setup in the UI (loopback), from Solco you'll need:
       ARTEX_URL       https://${PUBLIC_HOST}
       ARTEX_PASSWORD  the admin password you set in the UI
EOF

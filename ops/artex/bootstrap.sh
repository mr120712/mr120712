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
ARTEX_TAG="${ARTEX_TAG:-v0.7.0}"      # pin; bump only after reviewing upstream
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
if [ -d /home/user/mr120712/.git ]; then
  die "Looks like you're on the Solco repo checkout, not the VPS. Run this on the VPS."
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
if [ ! -d artex-src/.git ]; then
  say "Cloning ARTEX at $ARTEX_TAG…"
  git clone --depth 1 --branch "$ARTEX_TAG" "$ARTEX_REPO" artex-src
else
  say "artex-src/ already present; leaving it at its current revision."
  (cd artex-src && git fetch --tags --depth 1 origin "$ARTEX_TAG" >/dev/null 2>&1 || true)
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

  NEW_PG=$(prompt "Postgres password" "${POSTGRES_PASSWORD:-change-me-please}")
  [ "$NEW_PG" != "change-me-please" ] || warn "You kept the default Postgres password. Change it before any multi-user exposure."

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

# ---- 6. go ------------------------------------------------------------------
say "Starting the stack…"
docker compose up -d --build

cat <<EOF

[artex] Ready.
       UI:        http://127.0.0.1:8787  (open an SSH tunnel; see tunnel.md)
       Target:    $ARTEX_TARGET_HOST
       Logs:      docker compose logs -f artex
       Setup token (first visit only):
                  docker compose logs artex | grep "Setup token"

EOF

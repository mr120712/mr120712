#!/usr/bin/env bash
# @polsia:user-owned — one-shot bootstrap for the ARTEX ↔ Claude Agent SDK
# bridge on a VPS. Idempotent: safe to re-run.
#
# What it does, in order:
#   1. Verifies docker + docker compose are present (installs via get.docker.com
#      only when truly missing and the user agrees).
#   2. Pulls the latest commit from this branch (git clone or git pull).
#   3. Walks the user through writing ops/artex/.env, if missing.
#   4. Builds the `claude-bridge` image via docker compose.
#   5. Starts JUST the bridge service (postgres/artex/caddy stay down until
#      the user is ready — the bridge is useful on its own for /health
#      probing and `claude login`).
#   6. Waits for /health on 127.0.0.1:5057.
#   7. Prints the single next command the user runs: `docker compose exec
#      claude-bridge claude login` (interactive, browser URL printed).
#
# USAGE (on the VPS):
#   curl -fsSL https://raw.githubusercontent.com/mr120712/mr120712/claude/huggingface-deepseek-space-demo-3r1sz8/ops/artex/claude-bridge/vps-bootstrap.sh -o bridge-bootstrap.sh
#   less bridge-bootstrap.sh    # always read before piping to bash
#   bash bridge-bootstrap.sh
#
# Environment overrides:
#   REPO_DIR=/opt/artex    # where to clone (default: $HOME/mr120712)
#   BRANCH=...             # branch to check out (default: the one baked in)
#   SKIP_DOCKER_INSTALL=1  # don't attempt docker install
set -euo pipefail

# --- defaults -----------------------------------------------------------------
REPO_URL="${REPO_URL:-https://github.com/mr120712/mr120712.git}"
BRANCH="${BRANCH:-claude/huggingface-deepseek-space-demo-3r1sz8}"
REPO_DIR="${REPO_DIR:-$HOME/mr120712}"
BRIDGE_PORT="${BRIDGE_PORT:-5057}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '==> %s\n' "$*"; }
warn() { printf '!! %s\n' "$*" >&2; }
die()  { printf '!! %s\n' "$*" >&2; exit 1; }

# --- step 1: docker + compose -------------------------------------------------
ensure_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    info "docker + compose present ($(docker --version | awk '{print $3}' | tr -d ,))"
    return 0
  fi
  if [ "${SKIP_DOCKER_INSTALL:-0}" = "1" ]; then
    die "docker/compose missing and SKIP_DOCKER_INSTALL=1; install them and rerun"
  fi
  warn "docker/compose not found"
  read -r -p "Install docker now with get.docker.com? [y/N] " a
  case "$a" in
    [yY]*)
      info "installing docker (requires sudo)"
      curl -fsSL https://get.docker.com | sudo sh
      sudo systemctl enable --now docker
      if ! docker info >/dev/null 2>&1; then
        warn "cannot talk to docker as this user; add $USER to the docker group:"
        warn "  sudo usermod -aG docker $USER"
        warn "then log out and back in and rerun this script"
        exit 1
      fi
      ;;
    *)
      die "aborted; install docker and rerun"
      ;;
  esac
}

# --- step 2: repo -------------------------------------------------------------
ensure_repo() {
  if [ -d "$REPO_DIR/.git" ]; then
    info "repo present at $REPO_DIR; fetching + checking out $BRANCH"
    git -C "$REPO_DIR" fetch --quiet origin "$BRANCH"
    git -C "$REPO_DIR" checkout --quiet "$BRANCH"
    git -C "$REPO_DIR" pull --ff-only --quiet origin "$BRANCH"
  else
    info "cloning $REPO_URL ($BRANCH) → $REPO_DIR"
    git clone --quiet --branch "$BRANCH" --single-branch "$REPO_URL" "$REPO_DIR"
  fi
  [ -d "$REPO_DIR/ops/artex/claude-bridge" ] \
    || die "bridge directory missing after clone; wrong branch?"
}

# --- step 3: .env -------------------------------------------------------------
ensure_env() {
  cd "$REPO_DIR/ops/artex"
  if [ -f .env ]; then
    info "ops/artex/.env already present; leaving it alone"
    return 0
  fi
  info "writing ops/artex/.env (one-time, minimal for bridge-only start)"
  # Only the keys the bridge+compose layer needs. ARTEX itself stays down.
  read -r -p "ARTEX_PUBLIC_HOST (DNS A record → this VPS, e.g. artex.example.com): " PUBLIC_HOST
  read -r -p "ARTEX_TARGET_HOST (authorized staging target; default: solco preview) [default]: " TARGET_HOST
  TARGET_HOST="${TARGET_HOST:-mr120712-git-claude-huggingface-deepseek-spac-60b7de-solcomusic.vercel.app}"
  POSTGRES_PASSWORD="$(openssl rand -hex 16)"
  cat > .env <<EOF
# Written by claude-bridge vps-bootstrap on $(date -u +%Y-%m-%dT%H:%M:%SZ)
ARTEX_PUBLIC_HOST=$PUBLIC_HOST
ARTEX_TARGET_HOST=$TARGET_HOST
ARTEX_BIND_ADDR=127.0.0.1
POSTGRES_USER=artex
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
POSTGRES_DB=artex

# Bridge-backed planner. Any non-empty key works; the bridge ignores it.
ANTHROPIC_API_KEY=dummy-bridge-key
ARTEX_LLM_PROVIDER=anthropic
ARTEX_LLM_MODEL=claude-opus-4-7
ARTEX_LLM_BASE_URL=http://claude-bridge:5000
ARTEX_LLM_STREAM=false
BRIDGE_MAX_RPS=1.0
BRIDGE_MAX_CONCURRENCY=2
BRIDGE_CACHE_TTL_SECONDS=3600

ARTEX_NOISE_PROFILE=quiet
ARTEX_TASK_BUDGET_TOKENS=200000
ARTEX_TASK_BUDGET_TURNS=120
ARTEX_INTENT_BUDGET_TOKENS=60000
ARTEX_INTENT_BUDGET_TURNS=30
ARTEX_TARGET_USER_AGENT="ARTEX-solco-staging (+authorized self-test; owner mr120712)"
ARTEX_UPDATE_CHECK=
ARTEX_UNTRUSTED_BOUNDARY=
EOF
  chmod 600 .env
  info ".env written (mode 600)"
}

# --- step 4-5: build + start bridge ------------------------------------------
start_bridge() {
  cd "$REPO_DIR/ops/artex"
  info "building claude-bridge image (~3 min first time)"
  docker compose build claude-bridge
  info "starting claude-bridge (other services stay down)"
  docker compose up -d claude-bridge
}

# --- step 6: wait for /health -------------------------------------------------
wait_for_health() {
  info "waiting for bridge /health on 127.0.0.1:$BRIDGE_PORT (up to 90s)"
  local i
  for i in $(seq 1 90); do
    if curl -fsS -m 2 "http://127.0.0.1:$BRIDGE_PORT/health" >/dev/null 2>&1; then
      info "bridge is up: $(curl -fsS "http://127.0.0.1:$BRIDGE_PORT/health")"
      return 0
    fi
    sleep 1
  done
  warn "bridge did not come up in 90s; check logs:"
  warn "  docker compose logs claude-bridge | tail -50"
  exit 1
}

# --- step 7: next steps -------------------------------------------------------
print_next_steps() {
  cat <<EOF

$(bold "BRIDGE READY ✅")

  Health: http://127.0.0.1:$BRIDGE_PORT/health
  Image:  artex-claude-bridge:solco-staging

$(bold "NEXT: log the container into your Claude Code account")

The container needs your Claude Code auth to drive the subscription. Run:

  docker compose exec claude-bridge claude login

Follow the browser URL the CLI prints and finish the login flow in your
browser. The credentials land under /root/.claude inside the container and
survive restarts via the ./claude-bridge-auth bind mount on the host.

Verify:

  curl -s http://127.0.0.1:$BRIDGE_PORT/v1/messages \\
    -H 'x-api-key: dummy' \\
    -H 'content-type: application/json' \\
    -d '{
      "model": "claude-haiku-4-5",
      "max_tokens": 50,
      "messages": [{"role":"user","content":"say READY"}]
    }' | jq

$(bold "WHEN READY, BRING UP THE REST OF ARTEX")

  docker compose up -d        # postgres, artex, caddy

Then SSH-tunnel to port 8787 and finish the ARTEX bootstrap per
ops/artex/README.md. The bridge is already pointed at by .env; ARTEX
needs no further LLM config.

$(bold "DONE.")
EOF
}

main() {
  bold "ARTEX ↔ Claude Agent SDK bridge — VPS bootstrap"
  ensure_docker
  ensure_repo
  ensure_env
  start_bridge
  wait_for_health
  print_next_steps
}

main "$@"

#!/usr/bin/env bash
# ops/staging-db/bootstrap.sh — stand up Solco's staging Postgres on the Hetzner VPS.
#
# What it does:
#   1. Checks you're on the VPS (not the Solco repo checkout).
#   2. Installs Docker if needed (Ubuntu/Debian).
#   3. Generates a 40-char password and a self-signed TLS cert.
#   4. Writes .env (root, mode 600) and starts the postgres container.
#   5. Prints the two DATABASE_URL values to paste into Vercel preview env.
#
# Idempotent: re-run to restart with the same password and cert.
# --show-url    print the URLs for the existing .env and exit.
# --reset-pass  regenerate password and cert, WIPE the data volume.

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

say()  { printf '\033[1;34m[staging-db]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[staging-db]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[staging-db]\033[0m %s\n' "$*" >&2; exit 1; }

PUBLIC_IP="${PUBLIC_IP:-$(curl -fsSL --max-time 5 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')}"
[ -n "$PUBLIC_IP" ] || die "Could not determine the VPS public IP. Set PUBLIC_IP=... and re-run."

show_url() {
  # shellcheck disable=SC1091
  . ./.env
  cat <<EOF

[staging-db] Paste these into Vercel → Settings → Environment Variables,
             scope PREVIEW ONLY (uncheck Production and Development):

   DATABASE_URL              postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${PUBLIC_IP}:5433/${POSTGRES_DB}?sslmode=require
   DATABASE_URL_UNPOOLED     postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${PUBLIC_IP}:5433/${POSTGRES_DB}?sslmode=require

[staging-db] Keep these out of chat and out of git. The .env on this VPS at
             ${HERE}/.env is the only persistent copy.
EOF
}

case "${1:-}" in
  --show-url)
    [ -f .env ] || die "No .env yet. Run bootstrap.sh first."
    show_url
    exit 0
    ;;
  --reset-pass)
    warn "--reset-pass will delete the staging DB volume (all data)."
    read -r -p "Type 'reset' to continue: " ok
    [ "$ok" = "reset" ] || { warn "cancelled."; exit 1; }
    docker compose down -v 2>/dev/null || true
    rm -f .env tls/server.crt tls/server.key
    ;;
  "") ;;
  *) die "Unknown flag: $1" ;;
esac

# ---- sanity ----------------------------------------------------------------
# Refuse to run inside the Solco repo checkout; a no-op on the VPS's ~/staging-db.
if [ -d .git ] && git remote get-url origin 2>/dev/null | grep -qE 'mr120712/mr120712(\.git)?$'; then
  die "Looks like the Solco repo checkout, not the VPS's ~/staging-db. Run this on 5.222.15.32."
fi
[ -f /etc/os-release ] && grep -qiE "ubuntu|debian" /etc/os-release \
  || die "This bootstrap targets Ubuntu/Debian. On another OS, install Docker yourself."

# ---- Docker ---------------------------------------------------------------
if ! command -v docker >/dev/null; then
  say "Installing Docker Engine…"
  sudo apt-get update -y
  sudo apt-get install -y ca-certificates curl gnupg openssl
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/$(. /etc/os-release && echo "$ID")/gpg | \
    sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/$(. /etc/os-release && echo "$ID") \
$(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
    sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi
command -v openssl >/dev/null || sudo apt-get install -y openssl

# ---- TLS cert -------------------------------------------------------------
mkdir -p tls
if [ ! -f tls/server.key ]; then
  say "Generating self-signed TLS cert for CN=${PUBLIC_IP}…"
  openssl req -x509 -newkey rsa:4096 -nodes \
    -keyout tls/server.key -out tls/server.crt \
    -days 365 -subj "/CN=${PUBLIC_IP}" >/dev/null 2>&1
  # postgres on alpine runs as uid 70 and refuses a key the group can read.
  sudo chown 70:70 tls/server.key tls/server.crt
  sudo chmod 600 tls/server.key
  sudo chmod 644 tls/server.crt
fi

# ---- .env with a strong password -----------------------------------------
if [ ! -f .env ]; then
  PASS="$(openssl rand -base64 48 | tr -d '/+=' | head -c 40)"
  cat > .env <<EOF
POSTGRES_USER=solco_staging
POSTGRES_PASSWORD=${PASS}
POSTGRES_DB=solco_staging
EOF
  chmod 600 .env
fi

# ---- go -------------------------------------------------------------------
say "Starting the staging Postgres…"
docker compose up -d
sleep 2
docker compose ps

# Sanity ping over TLS (ssl=require). Password is in .env, read not printed.
. ./.env
if command -v psql >/dev/null; then
  say "Sanity check: SELECT 1 over TLS…"
  PGPASSWORD="$POSTGRES_PASSWORD" psql \
    "host=${PUBLIC_IP} port=5433 user=${POSTGRES_USER} dbname=${POSTGRES_DB} sslmode=require" \
    -c "SELECT 1" >/dev/null && say "✓ reachable over TLS"
else
  warn "psql not installed on the VPS; skipping the sanity check. Vercel will try to connect on the next build."
fi

show_url

#!/usr/bin/env bash
# ops/artex/fix-db.sh — one-shot repair for the "no database config found" loop.
# Pulls the current compose file, writes a valid config.json from .env (without
# relying on fragile shell escaping), then recreates the ARTEX container.
# Run on the VPS in ~/artex: bash fix-db.sh

set -euo pipefail
cd "$(dirname "$0")"

say()  { printf '\033[1;34m[fix-db]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[fix-db]\033[0m %s\n' "$*" >&2; exit 1; }

# ---- 1. prerequisites ------------------------------------------------------
[ -f .env ] || die "no .env in $(pwd) — run bootstrap.sh first."
command -v python3 >/dev/null || die "python3 missing (apt-get install -y python3)."
command -v docker  >/dev/null || die "docker missing (bootstrap.sh installs it)."

# ---- 2. pull the current compose + bootstrap -------------------------------
say "Pulling the current docker-compose.yml (adds the config.json mount)."
curl -fsSL "https://raw.githubusercontent.com/mr120712/mr120712/claude/huggingface-deepseek-space-demo-3r1sz8/ops/artex/docker-compose.yml" -o docker-compose.yml

# ---- 3. check .env has the three variables we need -------------------------
. ./.env
: "${POSTGRES_USER:?POSTGRES_USER missing in .env}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD missing in .env}"
: "${POSTGRES_DB:?POSTGRES_DB missing in .env}"

# ---- 4. write config.json with Python (heredoc isolates shell from JSON) ---
say "Writing config.json."
POSTGRES_USER="$POSTGRES_USER" POSTGRES_PASSWORD="$POSTGRES_PASSWORD" POSTGRES_DB="$POSTGRES_DB" \
  python3 <<'PYEOF' > config.json.tmp
import os, json
cfg = {
  "database": {
    "host": "postgres",
    "port": 5432,
    "user": os.environ["POSTGRES_USER"],
    "password": os.environ["POSTGRES_PASSWORD"],
    "dbname": os.environ["POSTGRES_DB"],
    "sslmode": "disable",
  },
}
print(json.dumps(cfg, indent=2))
PYEOF

python3 -c "import json; json.load(open('config.json.tmp'))" \
  || die "config.json.tmp is not valid JSON — aborting without overwriting."

mv config.json.tmp config.json
chmod 600 config.json
say "config.json written, parses as valid JSON. Password length: ${#POSTGRES_PASSWORD}."

# Show the redacted form.
python3 - <<'PYEOF'
import json
d = json.load(open("config.json"))
d["database"]["password"] = "<set>"
print(json.dumps(d, indent=2))
PYEOF

# ---- 5. recreate the ARTEX container ---------------------------------------
say "Recreating the artex container (postgres volume + caddy untouched)."
docker compose up -d --force-recreate --no-deps artex

# ---- 6. wait and report ----------------------------------------------------
sleep 8
echo "---"
docker compose ps
echo "---"
say "last 20 lines of artex log:"
docker compose logs --tail=20 artex
echo "---"
say "Done. Expected: pg_dsn_source now reads 'config file /app/config.json (database fields)'."

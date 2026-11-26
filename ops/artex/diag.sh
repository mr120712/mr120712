#!/usr/bin/env bash
# ops/artex/diag.sh — one-shot diagnostic for the ARTEX stack on the VPS.
# Run on the VPS, paste the output back. Nothing changes; reads only.

set +e
cd ~/artex 2>/dev/null || cd ~/artex-src/.. 2>/dev/null || true

divider() { printf '\n--- %s ---\n' "$*"; }

divider "where am I"
pwd
ls -la 2>/dev/null | head -20

divider "docker compose ps"
docker compose ps 2>&1

divider ".env (public config only, secrets REDACTED)"
if [ -f .env ]; then
  sed -E '
    s/(PASSWORD=)[^[:space:]]+/\1<REDACTED>/g;
    s/(API_KEY=)[^[:space:]]+/\1<REDACTED>/g;
    s/(TOKEN=)[^[:space:]]+/\1<REDACTED>/g;
    s/(SECRET=)[^[:space:]]+/\1<REDACTED>/g;
    s/(ANTHROPIC_API_KEY=)[^[:space:]]+/\1<REDACTED>/g;
    s/(OPENAI_API_KEY=)[^[:space:]]+/\1<REDACTED>/g;
  ' .env
else
  echo "no .env in $(pwd)"
fi

divider "Caddyfile"
cat Caddyfile 2>/dev/null || echo "no Caddyfile"

divider "docker compose logs caddy --tail=60"
docker compose logs --tail=60 caddy 2>&1

divider "docker compose logs artex --tail=30"
docker compose logs --tail=30 artex 2>&1

divider "ports listening (0.0.0.0 or ::)"
ss -tlnp 2>/dev/null | grep -E ':(80|443|8787|8788|5432|5433)\b' | head -20

divider "firewall from inside the VPS (iptables should be empty; Hetzner Cloud firewall does the work)"
iptables -L INPUT -n 2>/dev/null | head -5 || echo "no iptables"

divider "reachability tests"
# port 80 locally (should be open)
nc -zv -w 3 127.0.0.1 80 2>&1 | head -1
nc -zv -w 3 127.0.0.1 443 2>&1 | head -1
nc -zv -w 3 127.0.0.1 8787 2>&1 | head -1

divider "loopback probe of ARTEX"
curl -sS -o /dev/null -w "artex direct: http=%{http_code}\n" --max-time 5 http://127.0.0.1:8787/api/health

divider "DONE — paste the output above to the chat"

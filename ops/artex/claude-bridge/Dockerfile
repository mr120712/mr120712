# @polsia:user-owned — Dockerfile for the ARTEX ↔ Claude Agent SDK bridge.
# Needs Python (for the FastAPI service) + Node.js (because the Agent SDK
# spawns the real `claude` CLI binary, which is a Node package).
FROM python:3.12-slim

# System deps + Node.js 20 LTS + gosu (for the root→unprivileged drop).
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates gnupg gosu \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# Install the Claude Code CLI globally so `claude_agent_sdk` can spawn it.
# Pin a floor; a newer CLI is still allowed.
RUN npm install -g @anthropic-ai/claude-code@latest

# Unprivileged user the bridge runs as. Claude Code CLI refuses to use
# --dangerously-skip-permissions (the subprocess flag behind the SDK's
# permission_mode='bypassPermissions') when the current user is root, so
# the container MUST run as a non-root uid.
ARG BRIDGE_UID=10100
ARG BRIDGE_GID=10100
RUN groupadd --system --gid "${BRIDGE_GID}" bridge \
 && useradd  --system --uid "${BRIDGE_UID}" --gid "${BRIDGE_GID}" \
             --create-home --home-dir /home/bridge --shell /usr/sbin/nologin bridge

WORKDIR /app

# Python deps first, for better layer cache.
COPY pyproject.toml ./
RUN pip install --no-cache-dir \
      fastapi>=0.115 \
      'uvicorn[standard]>=0.32' \
      pydantic>=2.9 \
      claude-agent-sdk>=0.2 \
      aiosqlite>=0.20 \
      'httpx>=0.27,<0.29'

# App source.
COPY src ./src

# Entrypoint: start as root, chown the bind-mounted Claude auth + cache dirs
# so the (host-)root-owned mount is accessible to uid 10100, then drop
# privileges with gosu. Using gosu, not su, so the python process keeps
# PID 1 and signals from docker propagate cleanly.
COPY <<'EOF' /usr/local/bin/docker-entrypoint.sh
#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" = "0" ]; then
  mkdir -p /home/bridge/.claude /data
  chown -R bridge:bridge /home/bridge/.claude /data || true
  exec gosu bridge:bridge "$@"
fi
exec "$@"
EOF
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Credentials live under the unprivileged user's HOME now; the compose bind
# mount is remapped to /home/bridge/.claude (see docker-compose.yml). The
# `claude login` done on the OLD /root/.claude path will NOT carry over —
# redo it in the new container.
VOLUME ["/home/bridge/.claude"]

# Persisted cache DB.
VOLUME ["/data"]

ENV PYTHONPATH=/app/src \
    BRIDGE_PORT=5000 \
    BRIDGE_HOST=0.0.0.0 \
    BRIDGE_CACHE_PATH=/data/cache.sqlite \
    HOME=/home/bridge

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -fsS http://127.0.0.1:5000/health || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["python", "-m", "bridge.main"]

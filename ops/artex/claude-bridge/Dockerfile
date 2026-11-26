# @polsia:user-owned — Dockerfile for the ARTEX ↔ Claude Agent SDK bridge.
# Needs Python (for the FastAPI service) + Node.js (because the Agent SDK
# spawns the real `claude` CLI binary, which is a Node package).
FROM python:3.12-slim

# System deps + Node.js 20 LTS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# Install the Claude Code CLI globally so `claude_agent_sdk` can spawn it.
# Pin a floor; a newer CLI is still allowed.
RUN npm install -g @anthropic-ai/claude-code@latest

WORKDIR /app

# Python deps first, for better layer cache.
COPY pyproject.toml ./
RUN pip install --no-cache-dir \
      fastapi>=0.115 \
      'uvicorn[standard]>=0.32' \
      pydantic>=2.9 \
      claude-agent-sdk>=0.2 \
      aiosqlite>=0.20

# App source.
COPY src ./src

# The user's Claude Code credentials live in /root/.claude; expose it as a
# volume in docker-compose so one `claude login` on the host persists.
VOLUME ["/root/.claude"]

# Persisted cache DB.
VOLUME ["/data"]

ENV PYTHONPATH=/app/src \
    BRIDGE_PORT=5000 \
    BRIDGE_HOST=0.0.0.0 \
    BRIDGE_CACHE_PATH=/data/cache.sqlite

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -fsS http://127.0.0.1:5000/health || exit 1

CMD ["python", "-m", "bridge.main"]

#!/bin/sh
# Entrypoint for the ARTEX gateway container.
#
# Runs as root on entry so it can take ownership of the bind-mounted /data
# dir (SQLite file lives there; host-side ownership is unpredictable), then
# drops to the gateway user (uid 10002) before applying the Prisma schema
# and starting Next.js. The server never runs as root.

set -eu

: "${DATABASE_URL:?DATABASE_URL must be set (e.g. file:/data/gateway.db)}"

# Idempotent chown; no-op if already correct.
chown -R gateway:gateway /data

echo "[gateway] applying prisma schema to $DATABASE_URL"
# Standalone Next.js runner is npm-free, so call the prisma CLI entry point
# via node directly.
su-exec gateway:gateway node /app/node_modules/prisma/build/index.js \
    db push --skip-generate --accept-data-loss=false

exec su-exec gateway:gateway "$@"

#!/bin/sh
# Entrypoint for the ARTEX gateway container.
#
# Applies the Prisma schema against the SQLite file before Next.js starts. The
# file lives on a bind-mount (/data) so it survives container rebuilds; this
# is idempotent — a no-op if the schema is already up to date.

set -eu

: "${DATABASE_URL:?DATABASE_URL must be set (e.g. file:/data/gateway.db)}"

echo "[gateway] applying prisma schema to $DATABASE_URL"
npx prisma db push --skip-generate --accept-data-loss=false

exec "$@"

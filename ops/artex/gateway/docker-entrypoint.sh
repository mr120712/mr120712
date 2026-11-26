#!/bin/sh
# Entrypoint for the ARTEX gateway container.
#
# Applies the Prisma schema against the SQLite file before Next.js starts. The
# file lives on a bind-mount (/data) so it survives container rebuilds; this
# is idempotent — a no-op if the schema is already up to date.

set -eu

: "${DATABASE_URL:?DATABASE_URL must be set (e.g. file:/data/gateway.db)}"

echo "[gateway] applying prisma schema to $DATABASE_URL"
# The runner image carries node_modules/prisma but not npm — Next.js's
# standalone output is deliberately npm-free. Call the prisma CLI entry
# point via node directly; the hashbang on node_modules/prisma/build/index.js
# is "#!/usr/bin/env node" but the file is executed as a module here.
node /app/node_modules/prisma/build/index.js db push --skip-generate --accept-data-loss=false

exec "$@"

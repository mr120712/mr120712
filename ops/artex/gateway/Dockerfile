# syntax=docker/dockerfile:1.7

# ---------- builder ----------
FROM node:20-alpine AS builder
WORKDIR /app

# System deps for Prisma (openssl) and build-time compile.
RUN apk add --no-cache openssl libc6-compat

# Install JS deps against a locked manifest. --legacy-peer-deps is required
# because better-call@1.4.x peerOptional's zod@^4 while Solco pins zod@3;
# npm 10's resolver treats peerOptional as blocking, so we fall back to npm 6
# behaviour where peers are advisory. No runtime effect.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then \
      npm ci --legacy-peer-deps; \
    else \
      npm install --legacy-peer-deps; \
    fi

# Prisma must generate against the schema; do it before next build so the
# client is available during type-check.
COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json next.config.ts ./
COPY src ./src
COPY public ./public

# Build Next.js in standalone mode. SKIP_ENV_VALIDATION keeps the build
# off the Zod runtime checks — real env lands at container start, not build.
ENV NEXT_TELEMETRY_DISABLED=1 \
    SKIP_ENV_VALIDATION=1
RUN npm run build

# ---------- runner ----------
FROM node:20-alpine AS runner
WORKDIR /app
RUN apk add --no-cache openssl libc6-compat tini \
    && addgroup -S gateway -g 10002 \
    && adduser  -S gateway -G gateway -u 10002

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Next.js standalone output ships a minimal node_modules tree with ONLY the
# packages the app's own `import` graph reaches. The Prisma CLI is invoked
# at runtime by docker-entrypoint.sh (prisma db push), and its transitive
# deps (@prisma/config → effect, and others) are not in the standalone
# subset. Rather than cherry-pick every dep Prisma reaches, copy the full
# builder node_modules — the runner image is still modest (~450MB) and the
# alternative is a fragile list that breaks on every Prisma minor bump.
COPY --from=builder --chown=gateway:gateway /app/public ./public
COPY --from=builder --chown=gateway:gateway /app/.next/standalone ./
COPY --from=builder --chown=gateway:gateway /app/.next/static ./.next/static
COPY --from=builder --chown=gateway:gateway /app/prisma ./prisma
COPY --from=builder --chown=gateway:gateway /app/node_modules ./node_modules

# Data dir is a bind-mount from the host; the SQLite file lives inside it.
RUN mkdir -p /data && chown -R gateway:gateway /data
VOLUME /data

COPY --chown=gateway:gateway docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

USER gateway
EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--", "/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]

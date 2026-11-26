# syntax=docker/dockerfile:1.7

# ---------- builder ----------
FROM node:20-alpine AS builder
WORKDIR /app

# System deps for Prisma (openssl) and build-time compile.
RUN apk add --no-cache openssl libc6-compat

# Install JS deps against a locked manifest. If package-lock.json isn't present
# (first-time scaffold), npm install falls back to a fresh resolve.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Prisma must generate against the schema; do it before next build so the
# client is available during type-check.
COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json next.config.ts ./
COPY src ./src

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

# Next.js standalone output ships a minimal node_modules tree. We still need
# Prisma's generated client + engines and the schema for `prisma db push`.
COPY --from=builder --chown=gateway:gateway /app/public ./public
COPY --from=builder --chown=gateway:gateway /app/.next/standalone ./
COPY --from=builder --chown=gateway:gateway /app/.next/static ./.next/static
COPY --from=builder --chown=gateway:gateway /app/prisma ./prisma
COPY --from=builder --chown=gateway:gateway /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=gateway:gateway /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder --chown=gateway:gateway /app/node_modules/prisma ./node_modules/prisma

# Data dir is a bind-mount from the host; the SQLite file lives inside it.
RUN mkdir -p /data && chown -R gateway:gateway /data
VOLUME /data

COPY --chown=gateway:gateway docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

USER gateway
EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--", "/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]

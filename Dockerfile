# syntax = docker/dockerfile:1
# Fly.io image for the main Solco app (Next.js 16 + Prisma 6, MULTI-FILE schema in prisma/schema/).
# The app's primary deploy is Vercel; Vercel ignores this file (it runs its own Next build), so
# committing it is safe. Build context tip: add `.git/` to .dockerignore to shrink the upload.

ARG NODE_VERSION=22.21.1
FROM node:${NODE_VERSION}-slim AS base

LABEL fly_launch_runtime="Next.js/Prisma"
WORKDIR /app
ENV NODE_ENV="production"


# ---------- Build stage ----------
FROM base AS build

RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y build-essential node-gyp openssl pkg-config python-is-python3

# THE FIX for "Could not find Prisma Schema / schema.prisma: file not found":
# this repo's schema is a multi-file FOLDER (prisma/schema/*.prisma), located via prisma.config.ts.
# `postinstall` runs `prisma generate`, so prisma.config.ts AND the prisma/ folder (copied to ./prisma,
# NOT flattened) must both exist BEFORE `npm ci`.
COPY .npmrc package-lock.json package.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci --include=dev

# App + build. Fly has no secrets at build time and next.config.ts validates env eagerly, so skip
# that for the build (real values are injected at runtime). Pass NEXT_PUBLIC_APP_URL as a build arg
# if you want links/SEO to use your real URL instead of localhost (optional).
COPY . .
ARG NEXT_PUBLIC_APP_URL=""
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
ENV SKIP_ENV_VALIDATION=1
RUN npm run build


# ---------- Runtime stage ----------
FROM base

RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y openssl && \
    rm -rf /var/lib/apt/lists /var/cache/apt/archives

COPY --from=build /app /app

# Fly routes to internal_port 3000 (your fly.toml); Next defaults to 3000.
EXPOSE 3000

# Sync the Prisma schema to the DB (idempotent), then start Next. DATABASE_URL is a Fly secret.
CMD ["sh", "-c", "npx prisma@6.19.3 db push --skip-generate && exec npx next start -H 0.0.0.0 -p 3000"]

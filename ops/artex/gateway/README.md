# ARTEX Gateway

Better Auth username + password gateway in front of ARTEX. One admin, two env vars, done.

## Why

Caddy's HTTP basic-auth was a stopgap. Issues:

- Credentials get pasted into password managers, team chats, and shell history.
- No session concept: every request re-sends the password through every TLS-terminating intermediary.
- No way to cut a single device loose, only to the whole host at once.
- No audit trail.

The gateway is a tiny Next.js 16 app that:

1. Terminates Better Auth sessions (HTTP-only, SameSite=lax, signed cookies).
2. Authenticates one admin with username + password (seeded from env at container boot).
3. Reverse-proxies every other request to ARTEX at `http://artex:8787` on the compose network.
4. Keeps its auth DB (SQLite) separate from ARTEX's Postgres — losing one does not compromise the other.

## How it fits

```
  internet
     │
     ▼
  Caddy (:443, TLS)
     │
     ▼
  gateway (:3000, Next.js + Better Auth)
     │   ├─ /login, /api/auth/*          → served locally
     │   └─ everything else, when authed → rewrite to /_proxy/<path>
     │
     ▼ (only once the session cookie validates)
  artex (:8787, Go)
```

## Setup — first time on the VPS

### 1. Env vars

Append to `ops/artex/.env` on the VPS:

```sh
GATEWAY_ADMIN_USERNAME=admin
GATEWAY_ADMIN_PASSWORD=choose-a-strong-one
GATEWAY_BETTER_AUTH_SECRET=$(openssl rand -hex 32)
```

### 2. Build and start

```sh
cd ~/artex
docker compose up -d --build gateway caddy
docker compose logs -f gateway    # watch for "admin password set (first boot)"
```

The container runs `prisma db push` on startup — creates `/data/gateway.db` on first run and is a no-op after.

### 3. Sign in

Open `https://artex.solcomusic.online/` in a browser:

1. The gateway redirects to `/login`.
2. Enter the username + password from `.env`.
3. Done — you land on the ARTEX console, session cookie set for 24h.

## Rotating the password

Edit `GATEWAY_ADMIN_PASSWORD` in `.env` and:

```sh
docker compose up -d --force-recreate gateway
```

The seed re-hashes the stored credential on every boot, so the new password works on the next login.

## Rotating the session secret

Edit `GATEWAY_BETTER_AUTH_SECRET` in `.env` and recreate the gateway. All outstanding sessions on every device become invalid — everyone has to sign in again.

## Security notes

- **One username, one password.** No sign-up, no second account, no magic links, no email relay. The only way in is to know what's in `.env`.
- **Password hashed by Better Auth.** The seed uses Better Auth's own `hashPassword` (scrypt by default), so the stored hash is the exact shape the server verifies against on login — no custom crypto, no interop risk.
- **Edge session check.** Middleware verifies the Better Auth session cookie's HMAC against `BETTER_AUTH_SECRET` without a DB call, so unauthenticated traffic is bounced before Prisma is touched.
- **ARTEX keeps its own JWT auth.** A gateway bypass (SSH to the VPS, curl'ing 127.0.0.1:8787 directly) still lands on ARTEX's own authentication.
- **Rate limiting** sits on the Better Auth defaults for the credentials endpoint. Add aggressive IP rate limiting at the Caddy layer if the admin username is guessable.

## Backup

`ops/artex/gateway/data/gateway.db` is the whole state — admin user row + current sessions. Worst case loss: rebuild from env, log in again. A nightly `rsync` of `ops/artex/gateway/data/` to cold storage is enough if you want continuity.

## Troubleshooting

- **401 from Caddy, not the gateway login page**: Caddy's basic-auth block is still active on the VPS's live Caddyfile (not the committed one). `docker compose cp ./Caddyfile artex-caddy:/etc/caddy/Caddyfile && docker compose exec artex-caddy caddy reload --config /etc/caddy/Caddyfile`.
- **"Username or password not recognised"**: your `.env` value didn't propagate. Check `docker compose logs gateway --tail=20 | grep seed` — expect `admin password refreshed to env value` on every restart. If missing, the gateway container is running a stale image — `docker compose up -d --force-recreate gateway`.
- **"Invalid environment variables"**: Zod rejected a value. Typo in `.env` or a missing required var.
- **502 from the gateway to the user**: `_proxy/[[...path]]` could not reach `http://artex:8787`. Usually means ARTEX is down (`docker compose ps artex`) or the compose network lost DNS (`docker compose restart gateway`).

## Upgrading

```sh
cd ~/artex
git pull
docker compose up -d --build gateway
```

Prisma schema is applied on each container start via `prisma db push`; migrations are not used while we're on a single-table shape.

# ARTEX Gateway

Better Auth magic-link gateway in front of ARTEX. Replaces Caddy basic-auth with a proper first-party auth layer: single admin email, no sign-up, no password, one-click sign-in via a short-lived email link.

## Why

Caddy's HTTP basic-auth was a stopgap. Issues:

- Credentials get pasted into password managers, team chats, and shell history.
- No session concept: every request re-sends the password, which means every TLS log and every intermediary that terminates TLS gets it.
- No way to cut access to a single device, only to the whole host at once.
- No audit trail of who signed in.

The gateway is a tiny Next.js 16 app that:

1. Terminates Better Auth sessions (HTTP-only, SameSite=lax, signed cookies).
2. Issues sign-in links to exactly one admin email (`GATEWAY_ADMIN_EMAIL`).
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
     │   ├─ /login, /verify, /api/auth/*  → served locally
     │   └─ everything else, when authed  → rewrite to /_proxy/<path>
     │
     ▼ (only once the session cookie validates)
  artex (:8787, Go)
```

## Setup — first time on the VPS

The ARTEX bootstrap script (`../bootstrap.sh`) does not yet set up the gateway; for now the extra env vars go in the same `.env` as ARTEX.

### 1. Env vars

Append these to `ops/artex/.env` on the VPS:

```sh
# The one email allowed to sign in.
GATEWAY_ADMIN_EMAIL=you@yourdomain.example

# Better Auth cookie signing key. Rotate with the same openssl recipe as
# ARTEX_SECRET_KEY.
GATEWAY_BETTER_AUTH_SECRET=$(openssl rand -hex 32)

# Where the magic-link emails are relayed. Re-uses Solco's existing proxy.
POLSIA_EMAIL_PROXY_URL=https://solcomusic.online/api/email/send
POLSIA_EMAIL_API_KEY=            # optional bearer, blank if the relay is public

# Optional — defaults are sane.
GATEWAY_EMAIL_FROM=artex-gateway@solcomusic.online
GATEWAY_EMAIL_FROM_NAME=ARTEX Gateway
```

### 2. Build and start

```sh
cd ~/artex
docker compose up -d --build gateway caddy
docker compose logs -f gateway    # watch for "admin user ready for <email>"
```

The container runs `prisma db push` on startup, which creates `/data/gateway.db` with the Better Auth schema on first run and is a no-op after.

### 3. Sign in

Open `https://artex.solcomusic.online/` in a browser:

1. The gateway redirects you to `/login`.
2. Enter your admin email → click **Send sign-in link**.
3. Check the inbox; the link lands within a few seconds.
4. Click the link → you're signed in and the gateway forwards every subsequent request to ARTEX.

Sessions last 24 hours; the cookie is renewed on each request inside the final hour.

## Security notes

- **One email, enforced twice.** `disableSignUp: true` on the magic-link plugin refuses to generate a link for any email that doesn't already have a `User` row. Only the seeded `GATEWAY_ADMIN_EMAIL` has that row. A second check inside `sendMagicLink` suppresses mail delivery for any address that isn't the admin — so even a stray `User` row cannot cause an unexpected email to go out.
- **No email enumeration.** The `/api/auth/sign-in/magic-link` endpoint always returns 200 regardless of whether the email is allowed. Only delivery differs.
- **Edge session check.** The middleware verifies the Better Auth session cookie's HMAC against `BETTER_AUTH_SECRET` without a DB call, so unauthenticated traffic is bounced before Prisma is even touched. Expiry/revocation is still enforced on the next DB-touching handler call.
- **Rotating the session secret** invalidates every active session in the SQLite DB (none of them verify against the new HMAC). To force sign-out of all devices, rotate `GATEWAY_BETTER_AUTH_SECRET` and `docker compose up -d --force-recreate gateway`.
- **ARTEX still has its own JWT auth.** If someone bypasses the gateway (e.g. by SSH'ing to the VPS and curl'ing 127.0.0.1:8787), ARTEX still asks for its own JWT. Defence in depth.

## Backup

The whole auth DB is one file: `ops/artex/gateway/data/gateway.db`. It contains the admin user row and current sessions — nothing that needs to survive catastrophic loss (worst case, rotate the admin, re-sign-in). A nightly `rsync` of `ops/artex/gateway/data/` to cold storage is enough if you want continuity.

## Troubleshooting

- **401 from Caddy, not the login page**: Caddy's basic-auth block is still active in `/etc/caddy/Caddyfile` on the VPS (not the committed one). Replace it with `ops/artex/Caddyfile` and `docker compose up -d --force-recreate caddy`.
- **"email not allowed" in `gateway` logs**: self-test. Someone tried an address other than `GATEWAY_ADMIN_EMAIL`. No action needed.
- **Magic link email never arrives**: `docker compose logs gateway | grep -i mail`. The POLSIA_EMAIL_PROXY_URL relay may be refusing the sender; check the proxy logs on Solco too.
- **"Invalid environment variables"**: the gateway's Zod schema rejected a value. Typo in `.env` or a missing required var.
- **502 from the gateway to the user**: `_proxy/[[...path]]` could not reach `http://artex:8787`. Usually means ARTEX is down (`docker compose ps artex`) or the compose network lost DNS (`docker compose restart gateway`).

## Upgrading

```sh
cd ~/artex
git pull
docker compose up -d --build gateway
```

The Prisma schema is applied on each container start via `prisma db push`; migrations are not used while we're on a single-table shape.

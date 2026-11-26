# ARTEX Gateway

Better Auth passkey gateway in front of ARTEX. Replaces Caddy basic-auth with WebAuthn passkeys — FaceID, TouchID, Windows Hello, YubiKey. Zero email, zero password, zero third-party relay.

## Why

Caddy's HTTP basic-auth was a stopgap. Issues:

- Credentials get pasted into password managers, team chats, and shell history.
- No session concept: every request re-sends the password, which means every TLS log and every intermediary that terminates TLS gets it.
- No way to cut access to a single device, only to the whole host at once.
- No audit trail of who signed in.

The gateway is a tiny Next.js 16 app that:

1. Terminates Better Auth sessions (HTTP-only, SameSite=lax, signed cookies).
2. Accepts sign-in from a passkey registered on the admin's device(s).
3. Reverse-proxies every other request to ARTEX at `http://artex:8787` on the compose network.
4. Keeps its auth DB (SQLite) separate from ARTEX's Postgres — losing one does not compromise the other.

No email, no password: passkeys live in secure hardware (Secure Enclave, TPM, YubiKey) and never leave the device. Even if the gateway's SQLite file is exfiltrated, the attacker gets only public keys.

## How it fits

```
  internet
     │
     ▼
  Caddy (:443, TLS)
     │
     ▼
  gateway (:3000, Next.js + Better Auth)
     │   ├─ /login, /enroll, /api/auth/*     → served locally
     │   └─ everything else, when authed     → rewrite to /_proxy/<path>
     │
     ▼ (only once the session cookie validates)
  artex (:8787, Go)
```

## Setup — first time on the VPS

### 1. Env vars

Append to `ops/artex/.env` on the VPS:

```sh
GATEWAY_ADMIN_EMAIL=you@yourdomain.example
GATEWAY_BETTER_AUTH_SECRET=$(openssl rand -hex 32)
```

That's it. No email relay, no SMTP, no Resend API key. The gateway signs in the admin via one-time URLs printed to `docker compose logs gateway`.

### 2. Build and start

```sh
cd ~/artex
docker compose up -d --build gateway caddy
docker compose logs -f gateway    # watch for "admin user ready for <email>"
```

The container runs `prisma db push` on startup — creates `/data/gateway.db` on first run and is a no-op after.

### 3. Register the first passkey (one-time bootstrap)

1. Open `https://artex.solcomusic.online/` in a browser (on the device you want to sign in from — typically your laptop).
2. Click **First time? Set up a passkey →**.
3. Enter your admin email and click **Print bootstrap URL to logs**.
4. On the VPS: `docker compose logs gateway --tail=50`. Look for the boxed banner:

   ```
   ======================================================================
   ARTEX GATEWAY — one-time bootstrap sign-in link
   Valid for 10 minutes. Open this URL in a browser on the device
   where you want to register the passkey:

   https://artex.solcomusic.online/api/auth/magic-link/verify?token=...

   ======================================================================
   ```

5. Copy the URL, paste it in the browser from step 1. You land on `/enroll`.
6. Click **Register passkey**. Your device prompts for FaceID / TouchID / Windows Hello / YubiKey. Confirm.
7. Done. Future visits to `https://artex.solcomusic.online/` show the passkey sign-in — one click, no email, no server log reading.

### Adding another device

Repeat steps 1–6 on the new device. Each passkey is a separate row; sessions on one device are independent from passkeys on another.

### Losing a device

The passkey lives on the device's secure hardware, so losing the device means losing that passkey. Use another registered device to sign in, then delete the lost passkey row from the DB:

```sh
docker compose exec gateway sh -c 'sqlite3 /data/gateway.db "SELECT id, name, createdAt FROM passkey ORDER BY createdAt;"'
docker compose exec gateway sh -c 'sqlite3 /data/gateway.db "DELETE FROM passkey WHERE id = <id>;"'
```

If you have no other registered device, rotate `GATEWAY_BETTER_AUTH_SECRET`, restart the gateway, and run through the bootstrap again from a trusted device.

## Security notes

- **No shared secret humans can leak.** The admin never types a password. Passkeys are hardware-bound; the server stores public keys only.
- **One identity, enforced in two places.** `magicLink` has `disableSignUp: true` — a bootstrap URL is only ever created for an email that already has a `User` row, which (thanks to the seed) is only `GATEWAY_ADMIN_EMAIL`. Any other address produces a 200 response with no log line emitted. Second-line check inside `sendMagicLink` suppresses the stdout print for non-admin addresses as defence in depth.
- **No email enumeration.** The `/api/auth/sign-in/magic-link` endpoint always returns 200 regardless of whether the email is allowed. Only the stdout banner differs.
- **Edge session check.** Middleware verifies the Better Auth cookie HMAC against `BETTER_AUTH_SECRET` without a DB call, so unauthenticated traffic is bounced before Prisma is touched. Expiry/revocation is still enforced on the next DB-touching handler call.
- **Rotating the session secret** invalidates every active session AND every outstanding bootstrap URL in one shot (none of them verify against the new HMAC). `docker compose up -d --force-recreate gateway` after editing `GATEWAY_BETTER_AUTH_SECRET` in `.env`.
- **ARTEX keeps its own JWT auth.** A gateway bypass (SSH to the VPS, curl'ing 127.0.0.1:8787 directly) still lands on ARTEX's own authentication.
- **The bootstrap URL is secret like SSH access.** Anyone with shell on the VPS can read the gateway's stdout, so by reading the URL they can sign in. This is intentional — the same people who could read `docker compose logs` could also just curl ARTEX's socket directly. The gateway raises the bar to "whoever has shell is already trusted".

## Backup

`ops/artex/gateway/data/gateway.db` is the whole state — admin user row + current sessions + passkey public keys. Worst case loss: rotate the admin, re-register a passkey from a trusted device. A nightly `rsync` of `ops/artex/gateway/data/` to cold storage is enough if you want continuity.

## Troubleshooting

- **401 from Caddy, not the gateway login page**: Caddy's basic-auth block is still active on the VPS's live `Caddyfile` (not the committed one). `docker compose cp ./Caddyfile artex-caddy:/etc/caddy/Caddyfile && docker compose exec artex-caddy caddy reload --config /etc/caddy/Caddyfile`.
- **Passkey prompt never appears**: the browser rejects WebAuthn if `GATEWAY_URL` does not match the current origin, or if the origin is not HTTPS. Confirm `.env` has `ARTEX_PUBLIC_HOST=artex.solcomusic.online` and the browser's address bar says the same.
- **"No passkey available" on sign-in**: there is no passkey registered on this device yet. Request a bootstrap URL via the login page's "First time?" collapse, grab it from the logs, and register one.
- **"Invalid environment variables"**: the gateway's Zod schema rejected a value. Typo in `.env` or a missing required var.
- **502 from the gateway to the user**: `_proxy/[[...path]]` could not reach `http://artex:8787`. Usually means ARTEX is down (`docker compose ps artex`) or the compose network lost DNS (`docker compose restart gateway`).

## Upgrading

```sh
cd ~/artex
git pull
docker compose up -d --build gateway
```

The Prisma schema is applied on each container start via `prisma db push`; migrations are not used while we're on a single-table shape.

# Solco staging Postgres on the Hetzner VPS

A second Postgres container on `5.222.15.32`, separate from ARTEX's own DB,
that serves **only** the Vercel preview of Solco. ARTEX writes test payloads
here; production data is never touched.

## Shape

```
Hetzner VPS (5.222.15.32)
├── ARTEX stack (ops/artex/)
│   ├── artex (UI :8787 on loopback)
│   └── postgres (internal, no host port)
└── Solco staging stack (this folder)
    └── postgres (:5433 public, strong password + TLS)
                     ↑
             Vercel preview build connects here over the internet
```

## Security

- **Random 40-char password** generated at bootstrap; never committed.
- **TLS required**. `pg_hba.conf` accepts only `hostssl`; a non-TLS connection
  is rejected, so a password can't leak over cleartext.
- **Self-signed cert** generated at bootstrap. Vercel's preview uses
  `sslmode=require` (encryption without CA verification) — fine for a
  throwaway staging DB. If you want full cert validation later, swap in a
  Let's Encrypt cert.
- **Port 5433**, not the default 5432, so trivial scanners pass.
- **Hetzner Cloud firewall** should allow 5433 from `0.0.0.0/0`. The
  TLS+password gate is what protects it; limiting to Vercel's egress range
  is ineffective because Vercel's build egress rotates and isn't documented
  as a tight range.
- **Not the ARTEX stack**. A compromise of this DB can't pivot into ARTEX
  (different docker network, different container).

## Setup (on the Hetzner VPS)

```bash
ssh root@5.222.15.32
cd ~ && mkdir -p staging-db && cd staging-db
curl -fsSL https://raw.githubusercontent.com/mr120712/mr120712/claude/huggingface-deepseek-space-demo-3r1sz8/ops/staging-db/bootstrap.sh -o bootstrap.sh
curl -fsSL https://raw.githubusercontent.com/mr120712/mr120712/claude/huggingface-deepseek-space-demo-3r1sz8/ops/staging-db/docker-compose.yml -o docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/mr120712/mr120712/claude/huggingface-deepseek-space-demo-3r1sz8/ops/staging-db/pg_hba.conf -o pg_hba.conf
less bootstrap.sh    # read before running
bash bootstrap.sh
```

Bootstrap:

1. Generates a 40-char password and a self-signed TLS cert, both in `./tls/`
   and `.env`, owned by root, mode 600.
2. Starts Postgres on `0.0.0.0:5433` with TLS enforced.
3. Prints the two **DATABASE_URL** values to paste into Vercel preview env.

The connection strings are printed **once**, on the terminal. Copy both and
paste them straight into Vercel. If you lose them, re-run `bootstrap.sh
--show-url` from the VPS.

## Paste into Vercel

In Vercel → Project `mr120712` → Settings → Environment Variables, add:

| Key | Value | Environments |
| --- | --- | --- |
| `DATABASE_URL` | the pooled URL bootstrap printed | **Preview** only |
| `DATABASE_URL_UNPOOLED` | the direct URL bootstrap printed | **Preview** only |

(Both URLs are the same for a self-hosted Postgres — no pooler. Set both the
same.) Make sure Production and Development are unchecked on both.

Then redeploy the current branch; the next build should pass.

## Teardown

When the engagement is over:

```bash
cd ~/staging-db
docker compose down -v    # removes the container and the data volume
cd ..
rm -rf staging-db         # removes certs, .env, compose file
```

In Vercel, delete the preview-scoped `DATABASE_URL` and
`DATABASE_URL_UNPOOLED` so a future preview can't accidentally reconnect.

## What this is NOT

- Not a long-lived staging database. It's ephemeral by design: start it to
  run ARTEX, tear it down when done.
- Not backed up. Anything in it is throwaway.
- Not the right pattern for a live staging site a team shares. For that,
  Neon or Supabase are the right choices.

# Reaching the ARTEX UI without exposing it

`ARTEX_BIND_ADDR=127.0.0.1` — the UI listens only on the VPS's loopback. To
reach it from your laptop:

## Option A — SSH tunnel (the default; nothing else)

```bash
ssh -L 8787:127.0.0.1:8787 you@your-vps
```

Leave that session open. In your browser, go to `http://127.0.0.1:8787`. The
URL bar looks like localhost; the traffic travels the SSH tunnel to the VPS.

Close the SSH session, the UI is unreachable again.

## Option B — Tailscale (only if your laptop and VPS are already on it)

Install Tailscale on the VPS, `tailscale up`, then reach the UI at
`http://<vps-tailscale-name>:8787`. Scope the auth key to a tag so only your
nodes can see it.

Do **not** do either of these:

- Change `ARTEX_BIND_ADDR` to `0.0.0.0`. The UI has a setup-token first login,
  but it's not meant to live on the public internet, and the MITM proxy on
  `:8788` certainly isn't.
- Put the VPS behind Cloudflare or a reverse proxy and reach it that way. ARTEX
  isn't a public-facing app; the attack surface of exposing a pentesting tool
  outweighs the convenience.

## Troubleshooting

`Connection refused` — the stack didn't come up. Run `docker compose ps`; if
`artex` is `restarting`, `docker compose logs artex` tells you why. Usually the
LLM key is missing or the Postgres password has a character Compose read as
a variable (write `$$` for a literal `$`).

`Bad Gateway` — the UI came up before Postgres finished migrating. Give it
30 seconds and refresh.

`Where is the setup token?` — the first boot printed one line; grep for it:

```bash
docker compose logs artex | grep "Setup token"
```

If that returns nothing, the DB already has a user account — use that, or
reset with:

```bash
docker compose exec -T postgres psql -U artex -d artex -c \
  "TRUNCATE users RESTART IDENTITY CASCADE"
docker compose restart artex
```

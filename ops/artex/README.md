# ARTEX — pentesting the Solco staging preview from your VPS

A deployment bundle for running [ARTEX](https://github.com/BaaRai/ARTEX) on a VPS
**you control**, scoped to a **staging preview of Solco** — never production,
never third-party hosts.

ARTEX is an autonomous offensive agent: a planner, workers, real exploit tools,
and a recording MITM proxy. Keep it on infrastructure where you own the AUP and
pointed at hosts you own. Pointed anywhere else, you're in unauthorized-access
territory, no matter who hit you first.

## What this folder is

- `docker-compose.yml` — a locked-down ARTEX + Postgres stack (localhost bind,
  tight budgets, quiet noise profile, update check off).
- `.env.example` — the only knobs you set: Postgres password, the LLM key, and
  the staging host that is the *only* allowed target.
- `scope.json` — the scope seed ARTEX imports on first boot (one asset: your
  staging host). You cannot widen this from the UI without re-importing.
- `bootstrap.sh` — one script that installs Docker (if missing), writes `.env`
  from prompts, pulls the ARTEX source at the latest release tag (auto-discovered
  each run; `ARTEX_REF=main` opts in to post-release fixes, `ARTEX_REF=vX.Y.Z`
  pins), and starts the stack.
- `tunnel.md` — how to reach the UI without exposing it to the internet (SSH
  tunnel; never `0.0.0.0`).

## What you do, step by step

### 1. Make the VPS you'll use

A plain Ubuntu 24.04 VPS, 2 vCPU / 4 GB RAM / 40 GB disk is enough. Keep it on
an account separate from your personal one if you can; some providers flag
pentest tooling in abuse scans regardless of where it's aimed.

### 2. Make the staging preview of Solco

On Vercel, open the Solco project → Deployments → the branch
`claude/huggingface-deepseek-space-demo-3r1sz8` already has previews. Pick a
preview URL, e.g. `solco-git-your-branch.vercel.app`. That host — and only that
host — is the target.

If the preview shares a database with production, stop here and either (a) seed
a throwaway preview Postgres, or (b) scope ARTEX to look only, not write (no
exploit tools that create/modify rows). Exploits on a shared DB can corrupt
real users' data.

### 3. Run the bootstrap on the VPS

```bash
ssh you@your-vps
curl -fsSL https://raw.githubusercontent.com/mr120712/mr120712/claude/huggingface-deepseek-space-demo-3r1sz8/ops/artex/bootstrap.sh -o bootstrap.sh
less bootstrap.sh       # read it before running anything from the internet as root
bash bootstrap.sh
```

The script asks for three things: the staging host (`solco-git-....vercel.app`),
an LLM key (Anthropic or OpenAI), and a Postgres password. It writes those to
`.env` and starts the stack. Nothing listens on the public interface.

### 4. Open the UI over an SSH tunnel

```bash
# from your laptop
ssh -L 8787:127.0.0.1:8787 you@your-vps
# then visit http://127.0.0.1:8787 in your browser
```

On first visit, the setup page asks for a one-time token printed in the logs:

```bash
docker compose logs artex | grep "Setup token"
```

### 5. In the UI, confirm the scope

- Assets: only the staging host from `scope.json`. If anything else appears,
  delete it before starting a task.
- System → Settings → Noise profile: **quiet**.
- System → Settings → Worker count: **2**.
- Intercept: turn **approval-required on** for anything that writes
  (POST/PUT/DELETE/PATCH on your staging site), at least for the first run.

### 6. Run a task

A good first goal is bounded and defensive-flavoured:

> "On `solco-git-....vercel.app`, inventory public routes and reachable `/api`
> endpoints. Report missing authentication, CSRF (`sameOrigin`) on mutating
> handlers, open CORS, exposed debug surfaces, and leaking error messages.
> No writes. No credential bruteforcing. Report only."

Review findings in the UI. Fix them in Solco. Re-run the task.

### 7. Feeding findings back to Skynet (optional, later)

Once you trust the output, I can add a `POST /api/admin/skynet/artex-finding`
handler to Solco that takes an ARTEX finding JSON (owner-only, same-origin
sameOrigin not applicable because it's a cross-origin service; secured by the
same `SPACE_CHAT_API_KEY` pattern) and tightens the Skynet scanner rules
accordingly. Say the word and I'll build it. Offense stays on the VPS;
defense faces the internet.

## What is deliberately off

- `ARTEX_BIND_ADDR=127.0.0.1` — the UI is never on the public interface. Reach
  it over SSH tunneling (`tunnel.md`).
- `ARTEX_UPDATE_CHECK=` (unset) — no update banner, no GitHub ping.
- `ARTEX_NOISE_PROFILE=quiet` — 2 req/s per host, 1 in flight. Even on your
  own preview, pounding it is wasteful and masks real timing bugs.
- `ARTEX_TASK_BUDGET_TOKENS=200000` — one task can't run away with your LLM
  spend.
- No `extension/` in this bundle. The browser capture extension is a
  separate step; load it from the ARTEX checkout on your laptop if you need
  authenticated-flow capture, not from this VPS.
- No S3 archive. Findings stay on the VPS disk until you export them.

## What to keep an eye on

- **Ensure target lock.** If Vercel changes the preview URL, update
  `ARTEX_TARGET_HOST` in `.env` and re-import `scope.json`. The UI also lets
  you add assets; don't.
- **Rotate LLM keys**. The key lives in the VPS `.env`. If the VPS is ever
  shared or snapshotted, rotate it.
- **Delete after each engagement.** `docker compose down -v && rm -rf data/
  keys/` wipes the whole state. Spin up fresh for the next pass.

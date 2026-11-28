#!/usr/bin/env bash
# Entrypoint della toolbox: ricorda lo scope autorizzato e, se presente, espone il target di ARTEX
# come $TARGET così i comandi puntano per default all'host giusto. Non applica da solo un confine di
# rete: la disciplina dello scope è dell'operatore (punta solo al tuo host autorizzato).
set -euo pipefail

cat <<'BANNER'
────────────────────────────────────────────────────────────────────────────
  ARTEX pentest toolbox — SOLO host che possiedi / sei autorizzato a testare.
  Puntarla altrove è accesso non autorizzato. Stesso scope di ARTEX.
────────────────────────────────────────────────────────────────────────────
BANNER

if [ -n "${ARTEX_TARGET_HOST:-}" ]; then
  export TARGET="${ARTEX_TARGET_HOST}"
  echo "TARGET=${TARGET}  (da ARTEX_TARGET_HOST — usa \$TARGET nei comandi)"
else
  echo "TARGET non impostato. Passa -e ARTEX_TARGET_HOST=<tuo-host> per averlo in \$TARGET."
fi
echo

exec "$@"

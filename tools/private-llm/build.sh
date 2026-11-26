#!/usr/bin/env bash
# Build a refusal-ablated copy of $MODEL with OBLITERATUS into $OUT. Run on the GPU pod (see README).
set -euo pipefail

MODEL="${MODEL:-meta-llama/Llama-3.1-8B-Instruct}"
METHOD="${METHOD:-advanced}"
OUT="${OUT:-/workspace/liberated}"
# Pinned: commit of the pliny-the-prompter/obliteratus Space this setup was written against.
OBLITERATUS_REF="18f3a1061dac048e311260cccbaa2ea35ab5025f"
OBLITERATUS_GIT="https://huggingface.co/spaces/pliny-the-prompter/obliteratus"

if [ -f "$OUT/config.json" ]; then
  echo "Already built: $OUT (delete it to rebuild)."
  exit 0
fi

nvidia-smi --query-gpu=name,memory.total --format=csv

python3 -m venv /workspace/obl-venv
# shellcheck disable=SC1091
. /workspace/obl-venv/bin/activate
pip install --quiet --upgrade pip
# Clone normally (HF's git server rejects pip's partial clone), pin the commit, install from disk.
SRC=/workspace/obliteratus-src
[ -d "$SRC/.git" ] || GIT_LFS_SKIP_SMUDGE=1 git clone --quiet "$OBLITERATUS_GIT" "$SRC"
git -C "$SRC" fetch --quiet origin
git -C "$SRC" checkout --quiet "$OBLITERATUS_REF"
pip install --quiet "$SRC"

# HF_TOKEN (env) is picked up by huggingface_hub for gated models.
obliteratus obliterate "$MODEL" --method "$METHOD" --dtype bfloat16 --output-dir "$OUT"

test -f "$OUT/config.json" || { echo "No model written to $OUT" >&2; exit 1; }
echo "Done: $OUT"

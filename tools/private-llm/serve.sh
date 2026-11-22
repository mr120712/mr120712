#!/usr/bin/env bash
# Serve the model built by build.sh as an OpenAI-compatible API on :8000, behind VLLM_API_KEY.
set -euo pipefail

: "${VLLM_API_KEY:?Set VLLM_API_KEY first (see README step 3) — never serve without a key.}"
OUT="${OUT:-/workspace/liberated}"
NAME="${NAME:-solco-private}"
MAX_LEN="${MAX_LEN:-8192}"

test -f "$OUT/config.json" || { echo "Model not found in $OUT — run build.sh first." >&2; exit 1; }

if [ ! -x /workspace/vllm-venv/bin/vllm ]; then
  python3 -m venv /workspace/vllm-venv
  /workspace/vllm-venv/bin/pip install --quiet --upgrade pip vllm
fi

exec /workspace/vllm-venv/bin/vllm serve "$OUT" \
  --served-model-name "$NAME" \
  --api-key "$VLLM_API_KEY" \
  --host 0.0.0.0 --port 8000 \
  --max-model-len "$MAX_LEN" \
  --gpu-memory-utilization 0.92

#!/usr/bin/env bash
# Run Cairo-TTS LOCALLY on this instance (CPU only) with a thread budget. No Docker, no Hugging Face Space.
#   bash cairo/run-local.sh                  # auto threads = usable cores - 1 (when >= 4 cores)
#   CAIRO_NUM_THREADS=3 bash cairo/run-local.sh
#   CAIRO_TTS_QUANTIZE=1 bash cairo/run-local.sh     # int8: faster on small CPUs
# The model is fetched with the library's DEFAULT path (from_pretrained -> Hugging Face hub, cached in $HF_HOME) the first time.
# Then point the chat server at it:   VOICETUT_URL=http://127.0.0.1:7860
set -euo pipefail
cd "$(dirname "$0")"
VENV="${CAIRO_VENV:-$PWD/../.venv-cairo}"
PORT="${CAIRO_PORT:-7860}"
if [ ! -x "$VENV/bin/uvicorn" ]; then
  echo "==> creating $VENV (CPU torch, ~200 MB)"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --no-cache-dir typing-extensions filelock sympy networkx jinja2 fsspec setuptools
  "$VENV/bin/pip" install --no-cache-dir --no-deps torch --index-url https://download.pytorch.org/whl/cpu
  "$VENV/bin/pip" install --no-cache-dir -r requirements.txt
fi
export CAIRO_TTS_DEVICE=cpu PYTHONUNBUFFERED=1
export VOICETUT_SPEAKER="${VOICETUT_SPEAKER:-tarek}"
echo "==> Cairo-TTS on http://127.0.0.1:$PORT  (threads: ${CAIRO_NUM_THREADS:-auto})"
exec "$VENV/bin/uvicorn" app:app --host 127.0.0.1 --port "$PORT" --workers 1 --timeout-keep-alive 75

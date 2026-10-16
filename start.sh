#!/bin/sh
# One container, one public port ($PORT, the chat/web server). Inside it this script starts the voice backend on 127.0.0.1, then the chat server.
#
#   TTS_BACKEND=egy    (default) the Egyptian TTS pipeline in /opt/egy-tts: VoiceTut + Edge + espeak fallbacks, cache, admin dashboard at /admin
#   TTS_BACKEND=cairo  the old Cairo-TTS service (your cloned voice, my-voice.wav), 127.0.0.1:7860
#   TTS_BACKEND=none   no built-in voice (Edge voices only, or set VOICETUT_URL to an external service)
# Only one backend runs at a time (RAM). Anything you set as a Railway variable wins over the defaults chosen here.

BACKEND="${TTS_BACKEND:-egy}"
EGY_VENV="${EGY_VENV:-/opt/venv-egy}"
EGY_APP_DIR="${EGY_APP_DIR:-/opt/egy-tts}"
EGY_PORT="${EGY_PORT:-8000}"
CAIRO_VENV_UVICORN="${CAIRO_VENV_UVICORN:-/opt/venv/bin/uvicorn}"
EGY_UVICORN="${EGY_UVICORN:-$EGY_VENV/bin/uvicorn}"

# fall back to whatever was actually built into the image
if [ "$BACKEND" = "egy" ] && [ ! -x "$EGY_UVICORN" ]; then
  if [ -x "$CAIRO_VENV_UVICORN" ]; then echo "[start] Egyptian TTS pipeline not built into this image; using cairo"; BACKEND=cairo
  else echo "[start] Egyptian TTS pipeline not built into this image (build with WITH_EGY=1); no built-in voice"; BACKEND=none; fi
fi
if [ "$BACKEND" = "cairo" ] && [ ! -x "$CAIRO_VENV_UVICORN" ]; then echo "[start] Cairo-TTS not built into this image; no built-in voice"; BACKEND=none; fi

export CAIRO_LOCAL=0 EGY_LOCAL=0
if [ "$BACKEND" = "egy" ]; then
  # Where the pipeline keeps its small files (dashboard settings, phrase list, clone references, and the audio cache when no database is configured).
  # No Volume is required: if /data is not writable we use /tmp (lost on redeploy). To keep the AUDIO CACHE across redeploys without a Volume, set
  # CACHE_DATABASE_URL (or DATABASE_URL) to a Postgres URL: no code change. (A Volume at /data + RAILWAY_RUN_UID=0 also works and additionally keeps settings.)
  DATA="${DATA_DIR:-/data}"
  if ! { mkdir -p "$DATA" 2>/dev/null && [ -w "$DATA" ]; }; then
    DATA=/tmp/egy-data; mkdir -p "$DATA"
    echo "[start] no writable /data volume: settings stay in /tmp (reset on redeploy; set them as Railway variables). Audio cache: $( [ -n "${CACHE_DATABASE_URL:-$DATABASE_URL}" ] && echo 'database' || echo 'memory/tmp only until CACHE_DATABASE_URL is set' )"
  fi
  # Memory guard: VoiceTut on CPU needs a few GB. On a smaller plan, loading it would get the process OOM-killed at every start,
  # so the pipeline then runs WITHOUT VoiceTut (Edge ar-EG + espeak fallbacks) and says so. Override: ENGINES=... or EGY_FORCE_VOICETUT=1.
  MEMFILE="${CGROUP_MEM_FILE:-/sys/fs/cgroup/memory.max}"; [ -r "$MEMFILE" ] || MEMFILE=/sys/fs/cgroup/memory/memory.limit_in_bytes
  LIMIT="$(cat "$MEMFILE" 2>/dev/null)"; MIN_MB="${EGY_MIN_MEM_MB:-3500}"
  case "$LIMIT" in ''|*[!0-9]*) LIMIT_MB="" ;; *) LIMIT_MB=$((LIMIT / 1048576)) ;; esac
  if [ -z "$ENGINES" ] && [ "${EGY_FORCE_VOICETUT:-0}" != "1" ] && [ -n "$LIMIT_MB" ] && [ "$LIMIT_MB" -lt "$MIN_MB" ] && [ "$LIMIT_MB" -gt 0 ]; then
    echo "[start] memory limit ${LIMIT_MB} MB < ${MIN_MB} MB: VoiceTut is NOT loaded (it would be OOM-killed). Using edge,espeak. Raise the service memory or set EGY_FORCE_VOICETUT=1."
    ENGINES="edge,espeak"
    EGY_BOOT_NOTE="VoiceTut skipped at boot: container memory limit is ${LIMIT_MB} MB, below EGY_MIN_MEM_MB=${MIN_MB} MB (it would be OOM-killed). Raise the service memory to 4 GB or more, then set EGY_FORCE_VOICETUT=1 or enable it on the Engines tab."
  elif [ -n "$ENGINES" ]; then
    EGY_BOOT_NOTE="Engines come from the ENGINES variable (${ENGINES}); remove it or add voicetut to use the VoiceTut voice."
  elif [ -z "$LIMIT_MB" ]; then
    EGY_BOOT_NOTE="Container memory limit could not be read (${LIMIT:-no cgroup file}); memory guard not applied."
  fi
  # dashboard <-> the Node stream server (Stream tab): default to this very container, with the publisher password the Node side resolved
  if [ -z "$STREAM_ADMIN_TOKEN" ]; then
    STREAM_ADMIN_TOKEN="$(cd /app 2>/dev/null && node -e "require('./config.js');process.stdout.write(process.env.ADMIN_TOKEN||'')" 2>/dev/null)"
  fi
  echo "[start] launching the Egyptian TTS pipeline on 127.0.0.1:$EGY_PORT (dashboard: /admin $( [ -n "$TTS_ADMIN_TOKEN" ] && echo '[TTS_ADMIN_TOKEN set]' || echo '[DISABLED: set TTS_ADMIN_TOKEN]' ))"
  (
    # the dashboard has its OWN secret: TTS_ADMIN_TOKEN. The publisher's ADMIN_TOKEN is never accepted there (and vice versa).
    ADMIN_TOKEN="${TTS_ADMIN_TOKEN:-}"
    ADMIN_TOKEN_VAR=TTS_ADMIN_TOKEN
    STREAM_URL="${STREAM_URL:-http://127.0.0.1:${PORT:-3000}}"
    SETTINGS_FILE="${SETTINGS_FILE:-$DATA/settings.json}"
    PHRASES_FILE="${PHRASES_FILE:-$DATA/phrases.txt}"
    CACHE_DIR="${CACHE_DIR:-$DATA/audio-cache}"
    VOICETUT_REF_DIR="${VOICETUT_REF_DIR:-$DATA/refs}"
    [ -n "$ENGINES" ] && export ENGINES
    export EGY_BOOT_NOTE ADMIN_TOKEN ADMIN_TOKEN_VAR STREAM_URL STREAM_ADMIN_TOKEN SETTINGS_FILE PHRASES_FILE CACHE_DIR VOICETUT_REF_DIR
    cd "$EGY_APP_DIR" && exec nice -n 10 "$EGY_UVICORN" egy_tts.server:app --host 127.0.0.1 --port "$EGY_PORT" --log-level warning
  ) &
  export EGY_LOCAL=1 EGY_PORT
elif [ "$BACKEND" = "cairo" ]; then
  echo "[start] launching Cairo-TTS on 127.0.0.1:7860"
  # CPU thread budget: CAIRO_NUM_THREADS=N to pin it; default = usable cores (cgroup-aware) minus one for the chat server when >= 4 cores
  (cd /opt/cairo && exec uvicorn app:app --host 127.0.0.1 --port 7860 --workers 1 --timeout-keep-alive 75) &
  export CAIRO_LOCAL=1
fi
exec node /app/server.js
